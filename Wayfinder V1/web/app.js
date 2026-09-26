const $ = (selector) => document.querySelector(selector);
const video = $('#camera'), canvas = $('#capture'), status = $('#status');
const warning = $('#warning'), warningTitle = $('#warningTitle'), warningText = $('#warningText'), warningIcon = $('#warningIcon');
const enable = $('#enable'), pause = $('#pause'), destination = $('#destination'), listen = $('#listen');
const routeButton = $('#route'), directions = $('#directions');
const locationNote = $('#location');
const GEORGIA_TECH_FALLBACK = { lat: 33.7756, lng: -84.3963 };
let active = false, timer, audio, lastAlert = 0, navigation = null;

function speak(message, interrupt = false) {
  if (!('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 1.02;
  speechSynthesis.speak(utterance);
}

function setWarning(result) {
  const { level, message } = result.warning;
  warning.className = `warning ${level}`;
  warningTitle.textContent = level === 'clear' ? 'Path appears clear' : level === 'critical' ? 'Stop warning' : 'Obstacle warning';
  warningText.textContent = message;
  warningIcon.textContent = level === 'clear' ? '✓' : level === 'critical' ? '!' : '⚠';
  if (level !== 'clear' && Date.now() - lastAlert > 3500) { alertUser(message, level); lastAlert = Date.now(); }
}

function alertUser(message, level) {
  if (navigator.vibrate) navigator.vibrate(level === 'critical' ? [250, 100, 250, 100, 350] : [160, 90, 160]);
  const osc = audio?.createOscillator(), gain = audio?.createGain();
  if (osc && gain) {
    osc.frequency.value = level === 'critical' ? 880 : 660;
    gain.gain.setValueAtTime(.16, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .45);
    osc.connect(gain).connect(audio.destination); osc.start(); osc.stop(audio.currentTime + .46);
  }
  speak(message, true);
}

async function scan() {
  if (!active || video.readyState < 2) return;
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .72));
  try {
    const form = new FormData(); form.append('frame', blob, 'iphone-frame.jpg');
    const response = await fetch('/api/detect', { method: 'POST', body: form });
    if (!response.ok) throw new Error((await response.json()).detail);
    setWarning(await response.json()); status.textContent = 'Scanning the camera every 2 seconds.';
  } catch (error) { status.textContent = `Vision service: ${error.message}`; }
}

enable.addEventListener('click', async () => {
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)(); await audio.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play(); active = true; enable.disabled = true; pause.disabled = false;
    scan(); timer = setInterval(scan, 2000); status.textContent = 'Camera connected. Scanning every 2 seconds.';
  } catch (error) { status.textContent = `Camera unavailable: ${error.message}`; }
});

pause.addEventListener('click', () => {
  active = !active; pause.textContent = active ? 'Pause scanning' : 'Resume scanning';
  if (active) scan(); else { clearInterval(timer); timer = null; }
  if (active && !timer) timer = setInterval(scan, 2000);
});

listen.addEventListener('click', () => {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) { status.textContent = 'Voice capture is unavailable. Type the destination instead.'; return; }
  const recognition = new Speech(); recognition.lang = 'en-US';
  recognition.onresult = (event) => { destination.value = event.results[0][0].transcript; status.textContent = 'Destination captured.'; };
  recognition.onerror = () => { status.textContent = 'I could not hear that. Try again or type the destination.'; };
  recognition.start();
});

function distanceMeters(a, b) {
  const radius = 6371000, radians = (degrees) => degrees * Math.PI / 180;
  const p1 = radians(a.lat), p2 = radians(b.lat), dp = radians(b.lat - a.lat), dl = radians(b.lng - a.lng);
  const value = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function readableDistance(meters) {
  if (meters < 20) return 'now';
  if (meters < 160) return `in ${Math.round(meters / 5) * 5} meters`;
  return `in ${(meters / 1000).toFixed(1)} kilometers`;
}

async function navigationOrigin() {
  try {
    const current = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, maximumAge: 300000, timeout: 8000,
    }));
    const origin = { lat: current.coords.latitude, lng: current.coords.longitude };
    locationNote.textContent = `Using live GPS (${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}).`;
    return { origin, source: 'live GPS' };
  } catch {
    locationNote.textContent = 'Live GPS timed out. Using the Georgia Tech campus center as the starting point.';
    return { origin: GEORGIA_TECH_FALLBACK, source: 'Georgia Tech campus fallback' };
  }
}

function renderNavigation(position) {
  if (!navigation) return;
  const step = navigation.steps[navigation.stepIndex], next = navigation.steps[navigation.stepIndex + 1];
  const distance = step ? distanceMeters(position, step.location) : 0;
  directions.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = step ? `${step.instruction} ${readableDistance(distance)}` : 'Route complete.';
  const detail = document.createElement('p');
  detail.textContent = next ? `Then: ${next.instruction}` : `Destination: ${navigation.destination.display_name}`;
  const selected = document.createElement('p'); selected.className = 'muted';
  selected.textContent = `Nearest match selected: ${navigation.destination.display_name}. Start: ${navigation.locationSource}.`;
  const stop = document.createElement('button'); stop.textContent = 'Stop navigation'; stop.addEventListener('click', () => stopNavigation(false));
  directions.append(heading, detail, selected, stop);
}

function updateNavigation(geoPosition) {
  if (!navigation) return;
  const position = { lat: geoPosition.coords.latitude, lng: geoPosition.coords.longitude };
  let step = navigation.steps[navigation.stepIndex];
  if (!step) { stopNavigation(true); return; }
  let distance = distanceMeters(position, step.location);
  if (distance < 28 && navigation.stepIndex < navigation.steps.length - 1) {
    speak(step.instruction, true); navigation.stepIndex += 1; navigation.announcedAt = new Set();
    step = navigation.steps[navigation.stepIndex]; distance = distanceMeters(position, step.location);
  }
  for (const threshold of [120, 60]) {
    if (distance <= threshold && !navigation.announcedAt.has(threshold)) {
      speak(`${readableDistance(distance)}, ${step.instruction}`); navigation.announcedAt.add(threshold);
    }
  }
  renderNavigation(position);
}

function stopNavigation(arrived) {
  if (!navigation) return;
  navigator.geolocation.clearWatch(navigation.watchId);
  if (arrived) speak(`You have arrived at ${navigation.destination.name}.`, true);
  navigation = null; directions.textContent = arrived ? 'You have arrived.' : 'Navigation stopped.';
}

routeButton.addEventListener('click', async () => {
  const query = destination.value.trim();
  if (query.length < 2) { status.textContent = 'Say or type a destination first.'; return; }
  routeButton.disabled = true; directions.hidden = false;
  directions.textContent = 'Locating you and selecting the nearest matching destination…';
  try {
    const { origin, source } = await navigationOrigin();
    const response = await fetch('/api/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destination: query, origin }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.detail);
    if (navigation) navigator.geolocation.clearWatch(navigation.watchId);
    navigation = { ...data.route, destination: data.destination, locationSource: source, stepIndex: Math.min(1, data.route.steps.length - 1), announcedAt: new Set(), watchId: null };
    navigation.watchId = navigator.geolocation.watchPosition(updateNavigation, () => { status.textContent = 'Live GPS unavailable. Check Location Services.'; }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    const minutes = Math.max(1, Math.round(data.route.duration_s / 60)), kilometers = (data.route.distance_m / 1000).toFixed(1);
    const sourceMessage = source === 'live GPS' ? '' : ' Live GPS was unavailable, so the route starts at the Georgia Tech campus center.';
    speak(`Nearest match selected: ${data.destination.name}. ${kilometers} kilometers, about ${minutes} minutes.${sourceMessage} ${data.route.steps[0]?.instruction || ''}`, true);
    renderNavigation(origin); status.textContent = source === 'live GPS' ? 'Live spoken walking navigation active.' : 'Route ready from Georgia Tech; waiting for live GPS.';
  } catch (error) { directions.textContent = `Directions unavailable: ${error.message}`; }
  finally { routeButton.disabled = false; }
});
