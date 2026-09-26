import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://10.90.87.134:8000';
type Point = { lat: number; lng: number };
const KLAUS_ORIGIN: Point = { lat: 33.77717, lng: -84.39622 };
type RouteStep = { instruction: string; location: Point; distance_m: number };
type RouteData = { destination: { name: string; display_name: string }; route: { distance_m: number; duration_s: number; steps: RouteStep[] } };

const distanceMeters = (a: Point, b: Point) => {
  const r = 6371000, rad = (n: number) => n * Math.PI / 180;
  const p1 = rad(a.lat), p2 = rad(b.lat), dp = rad(b.lat - a.lat), dl = rad(b.lng - a.lng);
  const value = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};
const readableDistance = (meters: number) => meters < 20 ? 'now' : meters < 160 ? `in ${Math.round(meters / 5) * 5} meters` : `in ${(meters / 1000).toFixed(1)} kilometers`;

export default function App() {
  const camera = useRef<CameraView>(null);
  const scanning = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('Enable the rear camera and alerts.');
  const [warning, setWarning] = useState({ level: 'clear', message: 'Camera off' });
  const [destination, setDestination] = useState('');
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [route, setRoute] = useState<RouteData | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [distanceToStep, setDistanceToStep] = useState(0);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const routeRef = useRef<RouteData | null>(null);
  const stepIndexRef = useRef(0);
  const announced = useRef(new Set<number>());

  const speak = (text: string) => { Speech.stop(); Speech.speak(text, { rate: 0.95 }); };

  const scanFrame = async () => {
    if (!camera.current || scanning.current || !enabled) return;
    scanning.current = true;
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.55, skipProcessing: true });
      if (!photo?.uri) return;
      const body = new FormData();
      body.append('frame', { uri: photo.uri, name: 'iphone-frame.jpg', type: 'image/jpeg' } as never);
      const response = await fetch(`${API_URL}/api/detect`, { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Vision request failed');
      setWarning(data.warning);
      setStatus('Scanning every 2 seconds.');
      if (data.warning.level !== 'clear') {
        await Haptics.notificationAsync(data.warning.level === 'critical' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Warning);
        speak(data.warning.message);
      }
    } catch (error) { setStatus(`Vision unavailable: ${(error as Error).message}`); }
    finally { scanning.current = false; }
  };

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(scanFrame, 2000);
    return () => clearInterval(id);
  }, [enabled]);

  const enableCamera = async () => {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!permission.granted) { setStatus('Camera permission is required.'); return; }
    setEnabled(true); setStatus('Camera enabled.');
  };

  const updateNavigation = (position: Location.LocationObject) => {
    const currentRoute = routeRef.current;
    if (!currentRoute) return;
    const point = { lat: position.coords.latitude, lng: position.coords.longitude };
    const step = currentRoute.route.steps[stepIndexRef.current];
    if (!step) return;
    const distance = distanceMeters(point, step.location);
    setDistanceToStep(distance);
    if (distance < 28 && stepIndexRef.current < currentRoute.route.steps.length - 1) {
      speak(step.instruction); stepIndexRef.current += 1; setStepIndex(stepIndexRef.current); announced.current.clear(); return;
    }
    for (const threshold of [120, 60]) if (distance <= threshold && !announced.current.has(threshold)) {
      speak(`${readableDistance(distance)}, ${step.instruction}`); announced.current.add(threshold);
    }
  };

  const startNavigation = async () => {
    if (!destination.trim()) { setStatus('Enter a destination first.'); return; }
    setLoadingRoute(true); setStatus('Preparing directions…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      let origin = KLAUS_ORIGIN;
      if (permission.status === 'granted') {
        try {
          const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation });
          origin = { lat: current.coords.latitude, lng: current.coords.longitude };
        } catch {
          // Keep navigation available if the device cannot produce a GPS fix.
        }
      }
      const response = await fetch(`${API_URL}/api/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destination: destination.trim(), origin }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Route request failed');
      const routeData = data as RouteData;
      const initialStep = Math.min(1, routeData.route.steps.length - 1);
      routeRef.current = routeData; stepIndexRef.current = initialStep;
      setRoute(routeData); setStepIndex(initialStep); announced.current.clear();
      locationSubscription.current?.remove();
      locationSubscription.current = null;
      if (permission.status === 'granted') {
        try {
          locationSubscription.current = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 3, timeInterval: 1500 }, updateNavigation);
        } catch {
          // Route guidance remains available even when continuous GPS is unavailable.
        }
      }
      const minutes = Math.max(1, Math.round(routeData.route.duration_s / 60));
      speak(`Nearest match selected: ${routeData.destination.name}. About ${minutes} minutes. ${routeData.route.steps[0]?.instruction || ''}`);
      setStatus('Navigation active.');
    } catch (error) { setStatus(`Directions unavailable: ${(error as Error).message}`); }
    finally { setLoadingRoute(false); }
  };

  const stopNavigation = () => { locationSubscription.current?.remove(); locationSubscription.current = null; routeRef.current = null; setRoute(null); setStatus('Navigation stopped.'); Speech.stop(); };
  const step = route?.route.steps[stepIndex];

  return <SafeAreaView style={styles.safe}><StatusBar style="light"/><ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
    <Text style={styles.eyebrow}>ASSISTIVE WALKING COMPANION</Text><Text style={styles.title}>Wayfinder</Text><Text style={styles.status}>{status}</Text>
    <View style={[styles.warning, warning.level === 'critical' && styles.critical]}><Text style={styles.warningIcon}>{warning.level === 'clear' ? '✓' : '!'}</Text><Text style={styles.warningText}>{warning.message}</Text></View>
    <View style={styles.camera}>{cameraPermission?.granted && <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" animateShutter={false}/>}</View>
    <Pressable style={styles.primary} onPress={enableCamera}><Text style={styles.primaryText}>{enabled ? 'Alerts & camera enabled' : 'Enable alerts & camera'}</Text></Pressable>
    <View style={styles.panel}><Text style={styles.eyebrow}>LIVE SPOKEN NAVIGATION</Text>
      <TextInput style={styles.input} value={destination} onChangeText={setDestination} placeholder="Where do you want to go?" placeholderTextColor="#7f98aa" returnKeyType="go" onSubmitEditing={startNavigation}/>
      <Text style={styles.hint}>For voice input, tap the microphone on the iPhone keyboard.</Text>
      <Pressable style={styles.routeButton} onPress={startNavigation} disabled={loadingRoute}>{loadingRoute ? <ActivityIndicator color="#fff"/> : <Text style={styles.primaryText}>Start walking directions</Text>}</Pressable>
      {route && <View style={styles.routeCard}><Text style={styles.next}>{step ? `${step.instruction} ${readableDistance(distanceToStep)}` : 'Route complete.'}</Text><Text style={styles.routeDetail}>Nearest match: {route.destination.display_name}</Text><Pressable style={styles.stop} onPress={stopNavigation}><Text style={styles.primaryText}>Stop navigation</Text></Pressable></View>}
    </View>
    <Text style={styles.safety}>Safety: Wayfinder can miss hazards and GPS errors. Keep using your normal mobility aid and judgment.</Text>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#071b2d'},container:{padding:20,gap:14},eyebrow:{color:'#5fe0cf',fontSize:12,fontWeight:'800',letterSpacing:1.4},title:{color:'#eef7ff',fontSize:42,fontWeight:'800'},status:{color:'#aec2d3'},warning:{flexDirection:'row',alignItems:'center',gap:12,padding:16,borderRadius:16,backgroundColor:'#0b273c',borderWidth:1,borderColor:'#31506a'},critical:{backgroundColor:'#351d27',borderColor:'#ff6b6b'},warningIcon:{color:'#fff',fontSize:24,fontWeight:'900'},warningText:{color:'#eef7ff',fontSize:16,flex:1},camera:{height:280,borderRadius:18,overflow:'hidden',backgroundColor:'#04101c',borderWidth:1,borderColor:'#31506a'},primary:{minHeight:54,borderRadius:13,backgroundColor:'#5fe0cf',alignItems:'center',justifyContent:'center'},primaryText:{color:'#04232b',fontWeight:'800',fontSize:16},panel:{gap:12,padding:18,borderRadius:18,backgroundColor:'#0d2a42',borderWidth:1,borderColor:'#31506a'},input:{minHeight:54,borderRadius:12,paddingHorizontal:14,color:'#eef7ff',backgroundColor:'#061a2b',borderWidth:1,borderColor:'#31506a',fontSize:16},hint:{color:'#aec2d3',fontSize:13},routeButton:{minHeight:54,borderRadius:13,backgroundColor:'#176b76',alignItems:'center',justifyContent:'center'},routeCard:{gap:10,padding:14,borderRadius:12,backgroundColor:'#061a2b'},next:{color:'#eef7ff',fontSize:19,fontWeight:'800'},routeDetail:{color:'#aec2d3'},stop:{minHeight:48,borderRadius:12,backgroundColor:'#ff6b6b',alignItems:'center',justifyContent:'center'},safety:{color:'#aec2d3',fontSize:12,lineHeight:18,marginBottom:28}
});
