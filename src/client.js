'use strict';

require('dotenv').config();
const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const CLIENT_ID = process.env.MQTT_CLIENT_ID || `numeral-iot-${Math.random().toString(16).slice(2, 8)}`;
const USERNAME = process.env.MQTT_USERNAME || '';
const PASSWORD = process.env.MQTT_PASSWORD || '';

const SUBSCRIBE_TOPICS = (process.env.MQTT_SUBSCRIBE_TOPICS || 'iot/devices/#').split(',');
const PUBLISH_TOPIC = process.env.MQTT_PUBLISH_TOPIC || 'iot/devices/data';
const TRANSITTAG_TOPIC = process.env.MQTT_TRANSITTAG_TOPIC || 'topic/transittag/data';

const options = {
  clientId: CLIENT_ID,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
  ...(USERNAME && { username: USERNAME }),
  ...(PASSWORD && { password: PASSWORD }),
};

const client = mqtt.connect(BROKER_URL, options);

client.on('connect', () => {
  console.log(`[MQTT] Connected to broker: ${BROKER_URL}`);
  console.log(`[MQTT] Client ID: ${CLIENT_ID}`);

  SUBSCRIBE_TOPICS.forEach((topic) => {
    client.subscribe(topic.trim(), { qos: 1 }, (err) => {
      if (err) {
        console.error(`[MQTT] Failed to subscribe to ${topic}:`, err.message);
      } else {
        console.log(`[MQTT] Subscribed to topic: ${topic.trim()}`);
      }
    });
  });
});

client.on('message', (topic, payload) => {
  try {
    const message = JSON.parse(payload.toString());
    console.log(`[MQTT] Message received on "${topic}":`, message);
    handleMessage(topic, message);
  } catch {
    console.log(`[MQTT] Message received on "${topic}" (raw):`, payload.toString());
  }
});

client.on('reconnect', () => {
  console.log('[MQTT] Reconnecting...');
});

client.on('offline', () => {
  console.warn('[MQTT] Client is offline');
});

client.on('error', (err) => {
  console.error('[MQTT] Error:', err.message);
});

client.on('close', () => {
  console.log('[MQTT] Connection closed');
});

/**
 * Handle incoming MQTT messages.
 * @param {string} topic
 * @param {object|string} message
 */
function handleMessage(topic, message) {
  if (topic.startsWith('iot/devices/')) {
    const deviceId = topic.split('/')[2];
    console.log(`[Handler] Device "${deviceId}" sent:`, message);
  } else if (topic.startsWith('topic/transittag/')) {
    handleTransitTag(topic, message);
  }
}

/**
 * Handle messages on the topic/transittag/ hierarchy.
 * @param {string} topic  e.g. topic/transittag/scan, topic/transittag/data
 * @param {object|string} message
 */
function handleTransitTag(topic, message) {
  const subTopic = topic.slice('topic/transittag/'.length); // e.g. 'scan', 'data'
  console.log(`[TransitTag] Sub-topic: "${subTopic || '(root)'}"`, message);

  switch (subTopic) {
    case 'scan':
      console.log(`[TransitTag] Tag scanned:`, message.tagId || message);
      break;
    case 'data':
      console.log(`[TransitTag] Data payload:`, message);
      break;
    case 'status':
      console.log(`[TransitTag] Status update:`, message);
      break;
    default:
      console.log(`[TransitTag] Unhandled sub-topic "${subTopic}":`, message);
  }
}

/**
 * Publish a transit tag message.
 * @param {string} subTopic  e.g. 'scan', 'data', 'status'
 * @param {object|string} payload
 */
function publishTransitTag(subTopic, payload) {
  const topic = `topic/transittag/${subTopic}`;
  publish(topic, payload);
}

/**
 * Publish a message to the broker.
 * @param {string} topic
 * @param {object|string} payload
 * @param {object} [opts]
 */
function publish(topic, payload, opts = { qos: 1, retain: false }) {
  const data = typeof payload === 'object' ? JSON.stringify(payload) : payload;
  client.publish(topic, data, opts, (err) => {
    if (err) {
      console.error(`[MQTT] Publish failed on "${topic}":`, err.message);
    } else {
      console.log(`[MQTT] Published to "${topic}":`, data);
    }
  });
}

// Demo: publish a test message every 10 seconds when connected
let interval;
client.on('connect', () => {
  clearInterval(interval);
  interval = setInterval(() => {
    publish(PUBLISH_TOPIC, {
      deviceId: CLIENT_ID,
      timestamp: new Date().toISOString(),
      value: Math.round(Math.random() * 100),
    });
  }, 10000);
});

process.on('SIGINT', () => {
  console.log('\n[MQTT] Disconnecting...');
  clearInterval(interval);
  client.end(true, () => {
    console.log('[MQTT] Disconnected cleanly');
    process.exit(0);
  });
});

module.exports = { client, publish, publishTransitTag };
