import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as Location from "expo-location";
import { SpeechQueue } from "./speech";
import { PerceptionOverlay, RouteOverview } from "./visuals";
import { ScrollView, Pressable } from "react-native";
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

type Detection = {
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

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
  geometry?: number[][];
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
  detections?: Detection[];
  edge_map?: string | null;
  warning_emitted?: boolean;
  path?: { polygon: number[][]; center: number[][] } | null;
  frame_size?: number[];
  enabled?: boolean;
  token?: string;
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
  100,
  Number(process.env.EXPO_PUBLIC_CAPTURE_INTERVAL_MS ?? "100") || 100,
);

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [connection, setConnection] =
    useState<ConnectionState>("disconnected");
  const [streaming, setStreaming] = useState(false);
  const [distance, setDistance] = useState<number | null>(null);
  const [inference, setInference] = useState("waiting for a frame");
  const [lastAlert, setLastAlert] = useState("No alerts");
  const [destination, setDestination] = useState("");
  const [destinationPrompt, setDestinationPrompt] = useState("");
  const [speechListening, setSpeechListening] = useState(false);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [routeStepIndex, setRouteStepIndex] = useState(0);
  const [navigationStatus, setNavigationStatus] = useState("No route yet");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [frameProcessing, setFrameProcessing] = useState(false);
  const [pathEstimate, setPathEstimate] = useState<ServerMessage["path"]>(null);
  const [frameSize, setFrameSize] = useState([320, 240]);
  const [previewSize, setPreviewSize] = useState({ width: 1, height: 1 });
  const [position, setPosition] = useState<number[] | null>(null);
  const [hazard, setHazard] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [voiceMode, setVoiceMode] = useState("Device voice");
  const [settings, setSettings] = useState(false);
  const speech = useRef(new SpeechQueue()).current;
  speech.onMode = setVoiceMode;
  const clearFramesRef = useRef(0);
  const hazardRef = useRef(false);
  const frameStartedRef = useRef(0);
  const [nextDistance, setNextDistance] = useState<number | null>(null);
  const voiceRequestedRef = useRef(false);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const frameInFlightRef = useRef(false);

  const buzz = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, []);

  const enqueueSpeech = useCallback(
    (message: string, shouldBuzz: boolean) => {
      setLastAlert(message);
      if (shouldBuzz) buzz();
      speech.enqueue(message, shouldBuzz);
    },
    [buzz, speech],
  );

  const deliverAlert = useCallback(
    (message: string) => enqueueSpeech(message, true),
    [enqueueSpeech],
  );

  const speakInstruction = useCallback(
    (message: string) => enqueueSpeech(message, false),
    [enqueueSpeech],
  );

  const stopAudio = useCallback(() => {
    speech.stop();
  }, [speech]);

  const stopLocationTracking = useCallback(() => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
  }, []);

  const handleLocationUpdate = useCallback(
    (location: Location.LocationObject) => {
      setPosition([location.coords.longitude, location.coords.latitude]);
      if ((location.coords.accuracy ?? 100) > 35) {
        setNavigationStatus("GPS accuracy low. Pause route guidance.");
        return;
      }
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
        setNextDistance(Math.round(metersAway));
        if (metersAway > 12) break;
        nextIndex += 1;
        routeStepIndexRef.current = nextIndex;
        setRouteStepIndex(nextIndex);
        setNavigationStatus(nextStep.instruction);
        if (!hazardRef.current) speakInstruction(nextStep.instruction.replace(/^In .*?, /, ""));
        break;
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
    voiceRequestedRef.current = false;
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
    if (speechListeningRef.current) {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // The native speech module may be unavailable in Expo Go.
      }
    }
    speechListeningRef.current = false;
    pendingDestinationRef.current = "";
    socketRef.current?.close();
    socketRef.current = null;
    setConnection("disconnected");
    setStreaming(false);
    streamingRef.current = false;
    vlmBusyRef.current = false;
    setSpeechListening(false);
    stopAudio();
    stopLocationTracking();
    setDetections([]);
    setPathEstimate(null); setHazard(false); hazardRef.current = false; clearFramesRef.current = 0;
    frameInFlightRef.current = false;
    setFrameProcessing(false);
    routePlanRef.current = null;
    routeStepIndexRef.current = 0;
    routeRequestPendingRef.current = false;
    setRoutePlan(null);
    setRouteStepIndex(0);
    setNavigationStatus("No route yet");
  }, [stopAudio, stopLocationTracking]);

  const connect = useCallback(() => {
    disconnect();
    let parsed: URL;
    try {
      parsed = new URL(serverUrl.trim());
      if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch { setLastAlert("Enter a valid server URL, for example ws://192.168.1.2:8765/ws"); return; }
    speech.endpoint = `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
    setConnection("connecting");
    const socket = new WebSocket(serverUrl.trim());
    socketRef.current = socket;
    const connectionTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) { socket.close(); setLastAlert("Connection timed out. Check the server address and local network permission."); }
    }, 8000);

    socket.onopen = () => { clearTimeout(connectionTimer); if (socketRef.current !== socket) return; setConnection("connected"); setLastAlert("Connected. Ready to guide."); };
    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      try {
        const payload = JSON.parse(String(event.data)) as ServerMessage;
        if (payload.type === "speech_config") {
          speech.cloud = payload.enabled === true;
          speech.token = payload.token ?? "";
        } else if (payload.type === "route_plan" && payload.route?.steps?.length) {
          if (!routeRequestPendingRef.current) return;
          if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
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
          if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
          routeRequestPendingRef.current = false;
          setDestinationPrompt(`Route unavailable: ${payload.message ?? "try again"}`);
          setNavigationStatus("No route yet");
        } else if (payload.type === "status") {
          speech.cloud = payload.enabled === true;
          speech.token = payload.token ?? "";
        } else if (payload.type === "pipeline_state") {
          const busy = payload.state === "busy";
          vlmBusyRef.current = busy;
          if (!busy && frameInFlightRef.current) {
            frameInFlightRef.current = false;
            setFrameProcessing(false);
          }
        } else if (payload.type === "pipeline_busy") {
          frameInFlightRef.current = false;
          setFrameProcessing(false);
        } else if (payload.type === "collision_warning") {
          setInference(`possible collision: ${payload.label ?? "object"}`);
        } else if (payload.type === "detector_result") {
          setLatency(Date.now() - frameStartedRef.current);
          setFrameSize(payload.frame_size ?? [320, 240]);
          setPathEstimate(payload.path);
          if (payload.hazard) {
            clearFramesRef.current = 0; hazardRef.current = true; setHazard(true);
          } else if (++clearFramesRef.current >= 3 && hazardRef.current) {
            hazardRef.current = false; setHazard(false);
            const plan = routePlanRef.current;
            speakInstruction(plan ? `Obstacle no longer detected. ${plan.steps[routeStepIndexRef.current].instruction}` : "Obstacle no longer detected.");
          }
          if (!payload.hazard || payload.warning_emitted === false) {
            frameInFlightRef.current = false;
            setFrameProcessing(false);
          }
          setDetections(payload.detections ?? []);
          setInference(
            payload.hazard
              ? `possible collision: ${payload.label ?? "object"}`
              : "No obstacle detected",
          );
        } else if (payload.type === "alert" && payload.message) {
          frameInFlightRef.current = false;
          setFrameProcessing(false);
          deliverAlert(payload.message);
        } else if (payload.type === "vision_result") {
          setInference(
            payload.hazard ? `hazard: ${payload.message ?? "detected"}` : "No obstacle detected",
          );
        } else if (payload.type === "inference_error") {
          setInference(`error: ${payload.message ?? "inference failed"}`);
        } else if (payload.type === "detector_error") {
          frameInFlightRef.current = false;
          setFrameProcessing(false);
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
      clearTimeout(connectionTimer);
      if (socketRef.current === socket) {
        socketRef.current = null;
        setConnection("disconnected");
        setStreaming(false);
        streamingRef.current = false;
        routeRequestPendingRef.current = false;
        frameInFlightRef.current = false;
        setFrameProcessing(false);
        stopLocationTracking();
        stopAudio();
        setDetections([]); setPathEstimate(null); setHazard(false);
        setLastAlert("Connection lost. Guidance paused. Reconnect to resume.");
      }
    };
  }, [
    deliverAlert,
    disconnect,
    serverUrl,
    speakInstruction,
    startLocationTracking,
    stopLocationTracking,
    speech,
    stopAudio,
  ]);

  const sendFrame = useCallback(async () => {
    const socket = socketRef.current;
    if (
      !streamingRef.current ||
      vlmBusyRef.current ||
      capturingRef.current ||
      frameInFlightRef.current ||
      speech.busy ||
      !cameraRef.current ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    capturingRef.current = true;
    frameStartedRef.current = Date.now();
    frameInFlightRef.current = true;
    setFrameProcessing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.4,
        skipProcessing: false,
        shutterSound: false,
      });
      if (!photo) {
        frameInFlightRef.current = false;
        setFrameProcessing(false);
        return;
      }

      const resized = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 320 } }],
        { compress: 0.45, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!resized.base64) {
        frameInFlightRef.current = false;
        setFrameProcessing(false);
        return;
      }
      if (
        vlmBusyRef.current ||
        speech.busy ||
        socket.readyState !== WebSocket.OPEN
      ) {
        frameInFlightRef.current = false;
        setFrameProcessing(false);
        return;
      }

      socket.send(
        JSON.stringify({
          type: "frame",
          id: `${Date.now()}`,
          image: resized.base64,
        }),
      );
    } catch {
      frameInFlightRef.current = false;
      setFrameProcessing(false);
      setLastAlert("Camera frame failed");
    } finally {
      capturingRef.current = false;
    }
  }, [speech]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (frameInFlightRef.current && Date.now() - frameStartedRef.current > 15000) {
        setInference("Frame timed out. Reconnect to the server.");
        socketRef.current?.close();
      } else void sendFrame();
    }, CAPTURE_INTERVAL_MS);
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
    routeTimerRef.current = setTimeout(() => {
      routeRequestPendingRef.current = false;
      setDestinationPrompt("Route request timed out. Check your connection and try again.");
    }, 25000);
    setDestination(target);
    destinationTextRef.current = target;
    setDestinationPrompt("Getting your location…");
    setNavigationStatus("Finding a walking route…");

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        routeRequestPendingRef.current = false;
        setDestinationPrompt("Location permission is required for walking directions.");
        setNavigationStatus("Location permission denied");
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setPosition([position.coords.longitude, position.coords.latitude]);
      if (!routeRequestPendingRef.current) return;
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
      if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
      routeRequestPendingRef.current = false;
      setDestinationPrompt("Location is unavailable. Check permission and try again.");
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
        try {
          ExpoSpeechRecognitionModule.stop();
        } catch {
          // The end event will still finish the request if native stop fails.
        }
      } else {
        void startNavigationForDestination(transcript);
      }
    }
  });

  useSpeechRecognitionEvent("end", () => {
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    speechListeningRef.current = false;
    setSpeechListening(false);
    const target =
      pendingDestinationRef.current.trim() || destinationTextRef.current.trim();
    pendingDestinationRef.current = "";
    if (target && !streamingRef.current && voiceRequestedRef.current) {
      void startNavigationForDestination(target);
    } else if (!streamingRef.current) {
      setDestinationPrompt("No destination heard. Tap Start camera to try again.");
    }
    voiceRequestedRef.current = false;
  });

  useSpeechRecognitionEvent("error", (event) => {
    voiceRequestedRef.current = false;
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    speechListeningRef.current = false;
    pendingDestinationRef.current = "";
    setSpeechListening(false);
    setDestinationPrompt(`Speech recognition error: ${event.message || event.error}`);
  });

  const startDestinationCapture = useCallback(async () => {
    if (speechListeningRef.current || voiceRequestedRef.current) return;
    voiceRequestedRef.current = true;
    stopAudio();

    destinationTextRef.current = "";
    pendingDestinationRef.current = "";
    setDestination("");
    setDestinationPrompt("Requesting microphone permission…");

    try {
      const permission =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        voiceRequestedRef.current = false;
        setDestinationPrompt(
          "Microphone and speech permissions are required for voice destinations.",
        );
        return;
      }
      voiceTimerRef.current = setTimeout(() => {
        try { ExpoSpeechRecognitionModule.stop(); } catch {}
      }, 8000);

      try {
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
      } catch {
        // Keep a minimal fallback for native versions that do not support
        // punctuation/context options yet.
        ExpoSpeechRecognitionModule.start({
          lang: "en-US",
          interimResults: true,
          continuous: false,
        });
      }
    } catch {
      voiceRequestedRef.current = false;
      speechListeningRef.current = false;
      setSpeechListening(false);
      setDestinationPrompt(
        "Voice input is unavailable in this build. Type a destination instead.",
      );
    }
  }, [stopAudio]);

  const startStreaming = useCallback(() => {
    const target = destination.trim();
    if (target) {
      void startNavigationForDestination(target);
      return;
    }
    void startDestinationCapture();
  }, [destination, startDestinationCapture, startNavigationForDestination]);

  const cancelDestinationCapture = useCallback(() => {
    voiceRequestedRef.current = false;
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    if (speechListeningRef.current) {
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        // Speech is optional; cancelling it should never crash the app.
      }
    }
    speechListeningRef.current = false;
    pendingDestinationRef.current = "";
    setSpeechListening(false);
    setDestinationPrompt("");
  }, []);

  const stopStreaming = useCallback(() => {
    if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
    streamingRef.current = false;
    setStreaming(false);
    routeRequestPendingRef.current = false;
    routePlanRef.current = null;
    routeStepIndexRef.current = 0;
    setRoutePlan(null);
    setRouteStepIndex(0);
    setNavigationStatus("Navigation stopped");
    setDetections([]);
    setPathEstimate(null); setHazard(false); hazardRef.current = false; clearFramesRef.current = 0;
    frameInFlightRef.current = false;
    setFrameProcessing(false);
    stopLocationTracking();
    stopAudio();
  }, [stopAudio, stopLocationTracking]);

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
      <SafeAreaView style={{ flex: 1 }}>
        <View style={styles.header}>
          <View><Text style={styles.eyebrow}>WALKING COMPANION</Text><Text style={styles.title}>SmartSight</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="Connection settings" onPress={() => setSettings(!settings)} style={styles.connectionButton}>
            <Text style={{ color: connection === "connected" ? "#61d8c5" : "#f6cd70" }}>{connection === "connected" ? "● Connected" : "○ Connect"}</Text>
          </Pressable>
        </View>
        <View style={styles.preview} onLayout={event => setPreviewSize(event.nativeEvent.layout)}>
          <CameraView ref={cameraRef} facing="back" style={StyleSheet.absoluteFill} />
          <PerceptionOverlay boxes={detections} path={pathEstimate} frame={frameSize} size={previewSize} />
          <View style={styles.cameraCaption}>
            <Text style={styles.eyebrow}>{hazard ? "OBSTACLE DETECTED" : streaming ? "LIVE CAMERA" : "CAMERA READY"}</Text>
            <Text style={styles.status}>{pathEstimate ? "Estimated path boundaries" : "Path boundaries uncertain"}</Text>
          </View>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.panel} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>{routePlan ? `STEP ${routeStepIndex + 1} OF ${routePlan.steps.length}` : "YOUR NEXT WALK"}</Text>
          <Text style={styles.instruction}>{routePlan ? navigationStatus : "Where would you like to go?"}</Text>
          {routePlan && <Text style={styles.status}>{formatRouteSummary(routePlan)}{nextDistance !== null ? ` · ${nextDistance} m to next step` : ""}</Text>}
          <RouteOverview coordinates={routePlan?.geometry?.length ? routePlan.geometry : routePlan?.steps.map(s => [s.longitude, s.latitude]) ?? []} position={position} />
          {settings && <View style={styles.settings}>
          <Text style={styles.status}>Local inference server</Text>
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
          <Button title={connection === "connected" ? "Reconnect" : "Connect"} onPress={connect} />
          <Text style={styles.status}>{inference} · {voiceMode}</Text>
          <Text style={styles.status}>{latency === null ? "No frame measured" : `Frame round trip ${latency} ms`} · {detections.length} objects</Text>
          <Text style={styles.status}>{distance === null ? "Hardware not connected" : `Sensor ${distance.toFixed(0)} cm`} · {frameProcessing ? "Processing" : "Idle"}</Text>
          <Button title="Test alert" onPress={testAlert} />
          </View>}
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
            placeholder="Type destination, or use your voice"
            placeholderTextColor="#8e98a8"
            returnKeyType="done"
            style={styles.input}
            value={destination}
          />
          {destinationPrompt ? (
            <Text style={styles.prompt}>{destinationPrompt}</Text>
          ) : null}
          <Text accessibilityLiveRegion="assertive" style={[styles.alert, hazard && { borderColor: "#f6cd70", borderWidth: 1 }]}>
            {lastAlert}
          </Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={streaming ? "Stop navigation" : "Navigate using voice"}
              disabled={connection !== "connected" || speechListening}
              onPress={toggleStreaming}
              style={[styles.primary, connection !== "connected" && { opacity: .4 }]}>
              <Text style={styles.primaryText}>{speechListening ? "Listening…" : streaming ? "Stop navigation" : "Navigate / speak"}</Text>
            </Pressable>
            {speechListening ? (
              <Button title="Cancel voice" onPress={cancelDestinationCapture} />
            ) : null}
            {!streaming && <Button title="Camera only" disabled={connection !== "connected" || speechListening} onPress={() => { streamingRef.current = true; setStreaming(true); setNavigationStatus("Obstacle awareness only"); }} />}
          </View>
          {routePlan && <Button title="Repeat direction" onPress={() => speakInstruction(navigationStatus)} />}
          <Text style={styles.status}>Experimental guidance. Path estimates do not confirm clear ground.</Text>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 18 },
  eyebrow: { color: "#a9c3c8", fontSize: 11, letterSpacing: 2, fontWeight: "700" },
  connectionButton: { padding: 12, borderRadius: 20, backgroundColor: "#193139" },
  preview: { height: "35%", overflow: "hidden", marginHorizontal: 14, borderRadius: 22, backgroundColor: "#193139" },
  cameraCaption: { position: "absolute", top: 12, left: 12, padding: 10, borderRadius: 12, backgroundColor: "rgba(9,20,26,.8)" },
  instruction: { color: "#eef8f7", fontSize: 24, fontWeight: "600", lineHeight: 30 },
  settings: { gap: 8, padding: 12, backgroundColor: "#142b33", borderRadius: 14 },
  primary: { backgroundColor: "#61d8c5", paddingVertical: 16, paddingHorizontal: 22, borderRadius: 16, flexGrow: 1, alignItems: "center" },
  primaryText: { color: "#10262c", fontSize: 18, fontWeight: "700" },
  screen: { flex: 1, backgroundColor: "#090c10" },
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
  alert: { color: "#ffcf66", fontSize: 16, fontWeight: "600", padding: 14, borderRadius: 12, backgroundColor: "#192c32" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
