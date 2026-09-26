import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as Location from "expo-location";
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

type RouteStep = {
  instruction: string;
  distance_m: number;
  distance_to_maneuver_m: number;
  latitude: number;
  longitude: number;
};

type RoutePlan = {
  destination: string;
  distance_m: number;
  duration_s: number;
  steps: RouteStep[];
};

type ServerMessage = {
  type: string;
  message?: string;
  cm?: number;
  hazard?: boolean;
  source?: string;
  state?: "busy" | "idle";
  label?: string;
  vlm_enabled?: boolean;
  route?: RoutePlan;
};

function distanceBetweenMeters(
  firstLatitude: number,
  firstLongitude: number,
  secondLatitude: number,
  secondLongitude: number,
): number {
  const earthRadius = 6_371_000;
  const latitudeDelta = ((secondLatitude - firstLatitude) * Math.PI) / 180;
  const longitudeDelta = ((secondLongitude - firstLongitude) * Math.PI) / 180;
  const first = (firstLatitude * Math.PI) / 180;
  const second = (secondLatitude * Math.PI) / 180;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.sin(longitudeDelta / 2) ** 2 * Math.cos(first) * Math.cos(second);
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatRouteSummary(route: RoutePlan): string {
  const kilometers = route.distance_m / 1000;
  const minutes = Math.max(1, Math.round(route.duration_s / 60));
  return kilometers >= 1
    ? `${kilometers.toFixed(1)} km, about ${minutes} min`
    : `${Math.round(route.distance_m)} m, about ${minutes} min`;
}

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
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [routeStepIndex, setRouteStepIndex] = useState(0);
  const [navigationStatus, setNavigationStatus] = useState("No route yet");
  const cameraRef = useRef<CameraView>(null);
  const destinationTextRef = useRef("");
  const pendingDestinationRef = useRef("");
  const socketRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef(false);
  const capturingRef = useRef(false);
  const vlmBusyRef = useRef(false);
  const speechListeningRef = useRef(false);
  const routePlanRef = useRef<RoutePlan | null>(null);
  const routeStepIndexRef = useRef(0);
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const routeRequestPendingRef = useRef(false);

  const buzz = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, []);

  const deliverAlert = useCallback((message: string) => {
    setLastAlert(message);
    buzz();
    Speech.stop();
    Speech.speak(message, { language: "en", rate: 0.95 });
  }, [buzz]);

  const speakInstruction = useCallback((message: string) => {
    setLastAlert(message);
    Speech.stop();
    Speech.speak(message, { language: "en", rate: 0.9 });
  }, []);

  const stopLocationTracking = useCallback(() => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
  }, []);

  const handleLocationUpdate = useCallback(
    (location: Location.LocationObject) => {
      const plan = routePlanRef.current;
      if (!plan || plan.steps.length < 2) return;

      let nextIndex = routeStepIndexRef.current;
      while (nextIndex < plan.steps.length - 1) {
        const nextStep = plan.steps[nextIndex + 1];
        const metersAway = distanceBetweenMeters(
          location.coords.latitude,
          location.coords.longitude,
          nextStep.latitude,
          nextStep.longitude,
        );
        if (metersAway > 30) break;
        nextIndex += 1;
        routeStepIndexRef.current = nextIndex;
        setRouteStepIndex(nextIndex);
        setNavigationStatus(nextStep.instruction);
        speakInstruction(nextStep.instruction);
      }
    },
    [speakInstruction],
  );

  const startLocationTracking = useCallback(async () => {
    stopLocationTracking();
    try {
      locationSubscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 5,
          timeInterval: 1000,
        },
        handleLocationUpdate,
      );
    } catch {
      setNavigationStatus("Location tracking unavailable");
    }
  }, [handleLocationUpdate, stopLocationTracking]);

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
    stopLocationTracking();
    routePlanRef.current = null;
    routeStepIndexRef.current = 0;
    routeRequestPendingRef.current = false;
    setRoutePlan(null);
    setRouteStepIndex(0);
    setNavigationStatus("No route yet");
  }, [stopLocationTracking]);

  const connect = useCallback(() => {
    disconnect();
    setConnection("connecting");
    const socket = new WebSocket(serverUrl.trim());
    socketRef.current = socket;

    socket.onopen = () => setConnection("connected");
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as ServerMessage;
        if (payload.type === "route_plan" && payload.route?.steps?.length) {
          const plan = payload.route;
          routePlanRef.current = plan;
          routeStepIndexRef.current = 0;
          routeRequestPendingRef.current = false;
          setRoutePlan(plan);
          setRouteStepIndex(0);
          setNavigationStatus(plan.steps[0].instruction);
          setDestinationPrompt(`Route ready: ${formatRouteSummary(plan)}`);
          setLastAlert(`Navigating to ${plan.destination}`);
          streamingRef.current = true;
          setStreaming(true);
          speakInstruction(plan.steps[0].instruction);
          void startLocationTracking();
        } else if (payload.type === "route_error") {
          routeRequestPendingRef.current = false;
          setDestinationPrompt(`Route unavailable: ${payload.message ?? "try again"}`);
          setNavigationStatus("No route yet");
        } else if (payload.type === "status") {
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
        routeRequestPendingRef.current = false;
        stopLocationTracking();
      }
    };
  }, [
    deliverAlert,
    disconnect,
    serverUrl,
    speakInstruction,
    startLocationTracking,
    stopLocationTracking,
  ]);

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

  const startNavigationForDestination = useCallback(async (value: string) => {
    const target = value.trim();
    const socket = socketRef.current;
    if (!target || streamingRef.current || routeRequestPendingRef.current) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setDestinationPrompt("Connect to the server before starting navigation.");
      return;
    }

    routeRequestPendingRef.current = true;
    setDestination(target);
    destinationTextRef.current = target;
    setDestinationPrompt("Getting your location…");
    setNavigationStatus("Finding a walking route…");

    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      routeRequestPendingRef.current = false;
      setDestinationPrompt("Location permission is required for walking directions.");
      setNavigationStatus("Location permission denied");
      return;
    }

    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (socket.readyState !== WebSocket.OPEN) {
        routeRequestPendingRef.current = false;
        setDestinationPrompt("The server disconnected. Tap Connect and try again.");
        return;
      }
      setDestinationPrompt("Finding a walking route…");
      socket.send(
        JSON.stringify({
          type: "route_start",
          destination: target,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      );
    } catch {
      routeRequestPendingRef.current = false;
      setDestinationPrompt("Could not read your location. Try again outdoors.");
      setNavigationStatus("Location unavailable");
    }
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
        void startNavigationForDestination(transcript);
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
      void startNavigationForDestination(target);
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
      void startNavigationForDestination(target);
      return;
    }
    void startDestinationCapture();
  }, [destination, startDestinationCapture, startNavigationForDestination]);

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
    routeRequestPendingRef.current = false;
    routePlanRef.current = null;
    routeStepIndexRef.current = 0;
    setRoutePlan(null);
    setRouteStepIndex(0);
    setNavigationStatus("Navigation stopped");
    stopLocationTracking();
    Speech.stop();
  }, [stopLocationTracking]);

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
          <Text style={styles.status}>Navigation: {navigationStatus}</Text>
          {routePlan ? (
            <Text style={styles.status}>
              Step {Math.min(routeStepIndex + 1, routePlan.steps.length)} of {routePlan.steps.length} · {formatRouteSummary(routePlan)}
            </Text>
          ) : null}
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
              title={streaming ? "Stop navigation" : "Navigate / speak"}
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
