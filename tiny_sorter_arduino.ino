/*
 * ==============================================================================
 * Tiny Sorter — Hybrid Seed Separator (Arduino Code)
 * Architecture: Google Creative Lab "Tiny Sorter" Pattern
 * Compatible with: Arduino Uno, Nano, Leonardo, Mega, ESP32
 * ==============================================================================
 * Wiring:
 *   - Servo Signal (Orange/Yellow) -> Pin 9
 *   - Servo Power (Red)           -> 5V
 *   - Servo Ground (Brown/Black)  -> GND
 * ==============================================================================
 */

#include <Servo.h>

Servo sortingGate;
const int SERVO_PIN = 9;

// Flap angles
const int POS_CENTER = 90; // Neutral (middle)
const int POS_PEPPER = 45; // Divert left to Pepper Bin
const int POS_PAPAYA = 135; // Divert right to Papaya Bin

void setup() {
  Serial.begin(9600);
  sortingGate.attach(SERVO_PIN);
  sortingGate.write(POS_CENTER);
}

void loop() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();

    if (cmd == '1') {
      // 🌶️ Seed classified as Pepper -> Divert to Bin A
      sortingGate.write(POS_PEPPER);
      delay(900); // Time for seed to roll into bin
      sortingGate.write(POS_CENTER);
    } 
    else if (cmd == '2') {
      // 🥭 Seed classified as Papaya -> Divert to Bin B
      sortingGate.write(POS_PAPAYA);
      delay(900); // Time for seed to roll into bin
      sortingGate.write(POS_CENTER);
    }
  }
}
