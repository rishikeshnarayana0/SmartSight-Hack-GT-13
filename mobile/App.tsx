import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as Speech from "expo-speech";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type ConnectionState = "disconnected" | "connecting" | "connected";

type ServerMessage = {
  type: string;
  message?: string;
  cm?: number;
  hazard?: boolean;
  source?: string;
  state?: "busy" | "idle";
  label?: string;
  vlm_enabled?: boolean;
};

const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? "ws://localhost:8765/ws";
const CAPTURE_INTERVAL_MS = Math.max(
  500,
  Number(process.env.EXPO_PUBLIC_CAPTURE_INTERVAL_MS ?? "1000") || 1000,
);

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [connection, setConnection] =
    useState<ConnectionState>("disconnected");
  const [streaming, setStreaming] = useState(false);
  const [distance, setDistance] = useState<number | null>(null);
  const [inference, setInference] = useState("waiting for a frame");
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [vlmEnabled, setVlmEnabled] = useState(true);
  const [lastAlert, setLastAlert] = useState("No alerts");
  const [destination, setDestination] = useState("");
  const [destinationPrompt, setDestinationPrompt] = useState("");
  const [speechListening, setSpeechListening] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const destinationTextRef = useRef("");
  const pendingDestinationRef = useRef("");
  const socketRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef(false);
  const capturingRef = useRef(false);
  const vlmBusyRef = useRef(false);
  const speechListeningRef = useRef(false);

  const buzz = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, []);

  const deliverAlert = useCallback((message: string) => {
    setLastAlert(message);
    buzz();
    Speech.stop();
    Speech.speak(message, { language: "en", rate: 0.95 });
  }, [buzz]);

  const disconnect = useCallback(() => {
    if (speechListeningRef.current) {
      ExpoSpeechRecognitionModule.abort();
    }
    speechListeningRef.current = false;
    pendingDestinationRef.current = "";
    socketRef.current?.close();
    socketRef.current = null;
    setConnection("disconnected");
    setStreaming(false);
    streamingRef.current = false;
    vlmBusyRef.current = false;
    setPipelineBusy(false);
    setSpeechListening(false);
  }, []);

  const connect = useCallback(() => {
    disconnect();
    setConnection("connecting");
    const socket = new WebSocket(serverUrl.trim());
    socketRef.current = socket;

    socket.onopen = () => setConnection("connected");
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as ServerMessage;
        if (payload.type === "status") {
          setVlmEnabled(payload.vlm_enabled !== false);
        } else if (payload.type === "pipeline_state") {
          const busy = payload.state === "busy";
          vlmBusyRef.current = busy;
          setPipelineBusy(busy);
        } else if (payload.type === "collision_warning") {
          setInference(`possible collision: ${payload.label ?? "object"}`);
        } else if (payload.type === "detector_result") {
          setInference(
            payload.hazard
              ? `possible collision: ${payload.label ?? "object"}`
              : "clear",
          );
        } else if (payload.type === "alert" && payload.message) {
          deliverAlert(payload.message);
        } else if (payload.type === "vision_result") {
          setInference(
            payload.hazard ? `hazard: ${payload.message ?? "detected"}` : "clear",
          );
        } else if (payload.type === "inference_error") {
          setInference(`error: ${payload.message ?? "inference failed"}`);
        } else if (payload.type === "detector_error") {
          setInference(`detector error: ${payload.message ?? "detector failed"}`);
        } else if (payload.type === "distance" && typeof payload.cm === "number") {
          setDistance(payload.cm);
        }
      } catch {
        setLastAlert("Received an invalid server message");
      }
    };
    socket.onerror = () => setLastAlert("Could not reach the server");
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        setConnection("disconnected");
        setStreaming(false);
        streamingRef.current = false;
      }
    };
  }, [deliverAlert, disconnect, serverUrl]);

  const sendFrame = useCallback(async () => {
    const socket = socketRef.current;
    if (
      !streamingRef.current ||
      vlmBusyRef.current ||
      capturingRef.current ||
      !cameraRef.current ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    capturingRef.current = true;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.4,
        skipProcessing: true,
        shutterSound: false,
      });
      if (!photo) return;

      const resized = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 320 } }],
        { compress: 0.45, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!resized.base64) return;
      if (vlmBusyRef.current || socket.readyState !== WebSocket.OPEN) return;

      socket.send(
        JSON.stringify({
          type: "frame",
          id: `${Date.now()}`,
          image: resized.base64,
        }),
      );
    } catch {
      setLastAlert("Camera frame failed");
    } finally {
      capturingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void sendFrame(), CAPTURE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sendFrame]);

  useEffect(() => () => disconnect(), [disconnect]);

  const startStreamingForDestination = useCallback((value: string) => {
    const target = value.trim();
    if (!target || streamingRef.current) return;

    setDestinationPrompt("");
    setDestination(target);
    destinationTextRef.current = target;
    streamingRef.current = true;
    setStreaming(true);
    setLastAlert(`Destination set: ${target}`);
  }, []);

  useSpeechRecognitionEvent("start", () => {
    speechListeningRef.current = true;
    setSpeechListening(true);
    setDestinationPrompt("Listening… say where you want to go.");
  });

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript?.trim() ?? "";
    if (!transcript) return;

    destinationTextRef.current = transcript;
    setDestination(transcript);
    setDestinationPrompt(event.isFinal ? "Destination captured." : "Listening…");

    if (event.isFinal) {
      pendingDestinationRef.current = transcript;
      if (speechListeningRef.current) {
        ExpoSpeechRecognitionModule.stop();
      } else {
        startStreamingForDestination(transcript);
      }
    }
  });

  useSpeechRecognitionEvent("end", () => {
    speechListeningRef.current = false;
    setSpeechListening(false);
    const target =
      pendingDestinationRef.current.trim() || destinationTextRef.current.trim();
    pendingDestinationRef.current = "";
    if (target && !streamingRef.current) {
      startStreamingForDestination(target);
    } else if (!streamingRef.current) {
      setDestinationPrompt("No destination heard. Tap Start camera to try again.");
    }
  });

  useSpeechRecognitionEvent("error", (event) => {
    speechListeningRef.current = false;
    pendingDestinationRef.current = "";
    setSpeechListening(false);
    setDestinationPrompt(`Speech recognition error: ${event.message || event.error}`);
  });

  const startDestinationCapture = useCallback(async () => {
    if (speechListeningRef.current) return;

    destinationTextRef.current = "";
    pendingDestinationRef.current = "";
    setDestination("");
    setDestinationPrompt("Requesting microphone permission…");

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setDestinationPrompt(
        "Microphone and speech permissions are required for voice destinations.",
      );
      return;
    }

    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: false,
      addsPunctuation: true,
      contextualStrings: [
        "Georgia Tech",
        "student center",
        "library",
        "classroom",
        "dorm",
      ],
    });
  }, []);

  const startStreaming = useCallback(() => {
    const target = destination.trim();
    if (target) {
      startStreamingForDestination(target);
      return;
    }
    void startDestinationCapture();
  }, [destination, startDestinationCapture, startStreamingForDestination]);

  const cancelDestinationCapture = useCallback(() => {
    if (speechListeningRef.current) {
      ExpoSpeechRecognitionModule.abort();
    }
    speechListeningRef.current = false;
    pendingDestinationRef.current = "";
    setSpeechListening(false);
    setDestinationPrompt("");
  }, []);

  const stopStreaming = useCallback(() => {
    streamingRef.current = false;
    setStreaming(false);
  }, []);

  const toggleStreaming = () => {
    if (streamingRef.current) {
      stopStreaming();
    } else {
      startStreaming();
    }
  };

  const testAlert = () => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "demo_alert" }));
    } else {
      setLastAlert("Connect to the server first");
    }
  };

  if (!permission) {
    return <View style={styles.screen} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.permissionScreen}>
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.body}>
          The phone camera sends small frames to your local inference server.
        </Text>
        <Button title="Allow camera" onPress={requestPermission} />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <CameraView ref={cameraRef} facing="back" style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.overlay}>
        <View style={styles.panel}>
          <Text style={styles.title}>Assistive Prototype</Text>
          <TextInput
            accessibilityLabel="Server WebSocket URL"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setServerUrl}
            placeholder="ws://computer-ip:8765/ws"
            placeholderTextColor="#8e98a8"
            style={styles.input}
            value={serverUrl}
          />
          <TextInput
            accessibilityLabel="Navigation destination"
            autoCapitalize="sentences"
            autoCorrect
            editable={!streaming && !speechListening}
            onChangeText={(value) => {
              setDestination(value);
              destinationTextRef.current = value;
              if (value.trim()) setDestinationPrompt("");
            }}
            onSubmitEditing={startStreaming}
            placeholder="Where are you going? (or tap Start and speak)"
            placeholderTextColor="#8e98a8"
            returnKeyType="done"
            style={styles.input}
            value={destination}
          />
          {destinationPrompt ? (
            <Text style={styles.prompt}>{destinationPrompt}</Text>
          ) : null}
          <Text style={styles.status}>Server: {connection}</Text>
          <Text style={styles.status}>
            Speech: {speechListening ? "listening" : "off"}
          </Text>
          <Text style={styles.status}>
            Distance: {distance === null ? "no hardware" : `${distance.toFixed(0)} cm`}
          </Text>
          <Text style={styles.status}>Inference: {inference}</Text>
          <Text style={styles.status}>
            VLM: {!vlmEnabled ? "paused" : pipelineBusy ? "describing collision" : "ready"}
          </Text>
          <Text accessibilityLiveRegion="assertive" style={styles.alert}>
            {lastAlert}
          </Text>
          <View style={styles.row}>
            <Button
              title={connection === "connected" ? "Reconnect" : "Connect"}
              onPress={connect}
            />
            <Button
              disabled={connection !== "connected" || speechListening}
              title={streaming ? "Stop camera" : "Start camera / speak"}
              onPress={toggleStreaming}
            />
            {speechListening ? (
              <Button title="Cancel voice" onPress={cancelDestinationCapture} />
            ) : null}
            <Button title="Test alert" onPress={testAlert} />
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#090c10" },
  overlay: { flex: 1, justifyContent: "flex-end" },
  panel: {
    backgroundColor: "rgba(9, 12, 16, 0.90)",
    gap: 9,
    padding: 18,
  },
  permissionScreen: {
    flex: 1,
    justifyContent: "center",
    gap: 16,
    padding: 28,
    backgroundColor: "#090c10",
  },
  title: { color: "white", fontSize: 24, fontWeight: "700" },
  body: { color: "#d5dae2", fontSize: 17, lineHeight: 24 },
  input: {
    backgroundColor: "#18202b",
    borderColor: "#465367",
    borderRadius: 8,
    borderWidth: 1,
    color: "white",
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  status: { color: "#d5dae2", fontSize: 15 },
  prompt: { color: "#ffcf66", fontSize: 14, lineHeight: 19 },
  alert: { color: "#ffcf66", fontSize: 16, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
