#include <WiFi.h>
#include <PubSubClient.h>
#include "DHT.h"

// ================= WIFI =================
const char* ssid     = "RAN";
const char* password = "xxxxxxxxxxxx";

// ================= MQTT =================
const char* mqtt_server = "xxx.xx.xx.xxx";
const int   mqtt_port   = 1883;

const char* node_id     = "node_01";
const char* mqtt_topic  = "iot/node_01/data";

const char* mqtt_user   = "xxxxxxxxxxxxxxxxxxx";
const char* mqtt_pass   = "xxxxxxxxxxxxxxxxxxxxxxxxx";

// ================= DHT22 =================
#define DHTPIN  27
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// ================= ANALOG PINS =================
#define RAIN_AO 34   // ADC1
#define MQ_AO   35   // ADC1

// ================= ADC THRESHOLDS =================
const int RAIN_DETECT_ADC_TH = 2000;  // lower = wetter
const int MQ_DETECT_ADC_TH   = 2000;  // higher = more gas

// ================= MQTT CLIENT =================
WiFiClient espClient;
PubSubClient client(espClient);

// ================= TIMING =================
unsigned long lastPublish = 0;
const unsigned long publishInterval = 10000; // ✅ fixed 10 seconds

// ================= HELPERS =================
int readADC_Avg(int pin, int samples = 10) {
  long sum = 0;
  for (int i = 0; i < samples; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return sum / samples;
}

// ================= WIFI =================
void setup_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  Serial.print("Connecting WiFi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi connected ✅");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

// ================= MQTT =================
void reconnect_mqtt() {
  while (!client.connected()) {
    Serial.print("Connecting MQTT... ");
    String clientId = String("esp32_") + node_id + "_" +
                      String((uint32_t)ESP.getEfuseMac(), HEX);

    if (client.connect(clientId.c_str(), mqtt_user, mqtt_pass)) {
      Serial.println("connected ✅");
    } else {
      Serial.printf("failed rc=%d, retry...\n", client.state());
      delay(2000);
    }
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);

  // ADC config
  analogReadResolution(12);        // 0–4095
  analogSetAttenuation(ADC_11db);  // 0–3.3V range

  dht.begin();
  setup_wifi();

  client.setServer(mqtt_server, mqtt_port);

  Serial.println("ESP32 sensor node started ✅");
}

// ================= LOOP =================
void loop() {
  if (!client.connected()) reconnect_mqtt();
  client.loop();

  unsigned long now = millis();
  if (now - lastPublish < publishInterval) return;
  lastPublish = now;

  // ---------- READ DHT22 ----------
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();

  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("DHT read failed ❌");
    return;
  }

  // ---------- READ ANALOG SENSORS ----------
  int rain_adc = readADC_Avg(RAIN_AO);
  int mq_adc   = readADC_Avg(MQ_AO);

  // ---------- SIMPLE, STABLE DETECTION ----------
  bool rainDetected = (rain_adc < RAIN_DETECT_ADC_TH);
  bool gasDetected  = (mq_adc   > MQ_DETECT_ADC_TH);

  // ---------- BUILD JSON ----------
  char payload[256];
  snprintf(payload, sizeof(payload),
    "{"
      "\"node_id\":\"%s\","
      "\"temperature\":%.1f,"
      "\"humidity\":%.1f,"
      "\"rain_detected\":%s,"
      "\"rain_adc\":%d,"
      "\"gas_detected\":%s,"
      "\"mq_adc\":%d"
    "}",
    node_id,
    temperature, humidity,
    rainDetected ? "true" : "false", rain_adc,
    gasDetected  ? "true" : "false", mq_adc
  );

  // ---------- PUBLISH ----------
  if (client.publish(mqtt_topic, payload)) {
    Serial.print("Published: ");
    Serial.println(payload);
  } else {
    Serial.println("Publish failed ❌");
  }
}