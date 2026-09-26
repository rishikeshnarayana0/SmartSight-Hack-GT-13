// Minimal obstacle detector for an Arduino Uno or Nano.

const int TRIGGER_PIN = 9;
const int ECHO_PIN = 10;
const int MOTOR_PIN = 5;

const float ALERT_DISTANCE_CM = 100.0;
const float CLEAR_DISTANCE_CM = 115.0;  // Hysteresis prevents rapid buzzing.
const unsigned long SAMPLE_INTERVAL_MS = 250;

bool hazard = false;
unsigned long lastSampleAt = 0;

float readDistanceCentimeters() {
  digitalWrite(TRIGGER_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIGGER_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIGGER_PIN, LOW);

  // Timeout after 25 ms (roughly 4.3 m) so a missing echo cannot block the loop.
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 25000UL);
  if (duration == 0) {
    return -1.0;
  }
  return duration * 0.0343 / 2.0;
}

void setMotor(bool enabled) {
  analogWrite(MOTOR_PIN, enabled ? 180 : 0);
}

void setup() {
  pinMode(TRIGGER_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(MOTOR_PIN, OUTPUT);
  setMotor(false);

  Serial.begin(115200);
  Serial.println("hardware ready");
}

void loop() {
  unsigned long now = millis();
  if (now - lastSampleAt < SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSampleAt = now;

  float distance = readDistanceCentimeters();
  if (distance < 0) {
    hazard = false;
    setMotor(false);
    return;
  }

  if (!hazard && distance <= ALERT_DISTANCE_CM) {
    hazard = true;
  } else if (hazard && distance >= CLEAR_DISTANCE_CM) {
    hazard = false;
  }

  setMotor(hazard);

  Serial.print("{\"type\":\"distance\",\"cm\":");
  Serial.print(distance, 1);
  Serial.print(",\"hazard\":");
  Serial.print(hazard ? "true" : "false");
  Serial.println("}");
}

