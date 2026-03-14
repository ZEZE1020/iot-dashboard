# IoT Dashboard

A real-time IoT monitoring dashboard for MQTT brokers. Connect any MQTT broker and monitor devices with live alerts, historical data export, and an intuitive web interface.

![Demo](<Screen Recording 2026-03-13 235303.gif>)

## Features

- 📊 **Real-time Device Monitoring** - Track connected devices, signal strength, and status
- 🚨 **Intelligent Alerting** - Automatic alerts for low battery, offline devices, and missed heartbeats
- 📈 **Historical Data** - View and export device history with detailed logs
- 💾 **Data Export** - Download heartbeat, WiFi, and RFID data as CSV
- 🔌 **Broker Agnostic** - Works with any standard MQTT broker
- 📱 **Responsive Dashboard** - Works on desktop and mobile devices
- ⚡ **Real-time WebSocket** - Live updates via Socket.io

## Quick Start

### Prerequisites
- Node.js 16+
- MQTT Broker (local or remote)
- Docker (optional)

### Environment Setup

Create a `.env` file in the root directory:

```env
# Server
DASHBOARD_PORT=3000

# MQTT Broker
# This project was tested with mqtt://byte-iot.net:1883
# For local development, use: mqtt://localhost:1883 (see Mosquitto setup below)
MQTT_BROKER_URL=mqtt://byte-iot.net:1883
MQTT_USERNAME=
MQTT_PASSWORD=

# Client ID (auto-generated if not set)
MQTT_CLIENT_ID=numeral-dashboard

# MQTT Topics
MQTT_SUBSCRIBE_TOPICS=iot/devices/#
MQTT_PUBLISH_TOPIC=iot/devices/data
MQTT_TRANSITTAG_TOPIC=topic/transittag/data

# Alerting Thresholds
ALERT_LOW_BATTERY=20
ALERT_OFFLINE_SECONDS=120
ALERT_NO_HEARTBEAT_SECONDS=90
```

### Local Installation

```bash
# Install dependencies
npm install

# Start the server
npm start

# For development with auto-reload
npm run dev

# Run the MQTT client
npm run client
```

Server runs at `http://localhost:3000`

### Local Mosquitto MQTT Broker Setup

If you don't have access to a remote MQTT broker, you can run Mosquitto locally:

#### Option 1: Docker (Easiest)

```bash
# Pull and run Mosquitto
docker run -it -p 1883:1883 eclipse-mosquitto
```

Then update your `.env`:
```env
MQTT_BROKER_URL=mqtt://localhost:1883
```

#### Option 2: Native Installation

**macOS:**
```bash
brew install mosquitto
mosquitto -c /usr/local/etc/mosquitto/mosquitto.conf
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install mosquitto
sudo systemctl start mosquitto
sudo systemctl enable mosquitto  # auto-start on boot
```

**Windows:**
- Download from [mosquitto.org](https://mosquitto.org/download/)
- Install and run from Services

#### Testing Mosquitto Connection

```bash
# Subscribe to test topic in one terminal
mosquitto_sub -h localhost -t "test/topic"

# Publish test message in another terminal
mosquitto_pub -h localhost -t "test/topic" -m "Hello MQTT"
```

You should see the message appear in the subscriber terminal.

#### Using with Docker Compose

The included `docker-compose.yml` already includes a Mosquitto service. Simply run:

```bash
docker-compose up -d
```

This starts both the dashboard and a local Mosquitto broker.

### Docker Deployment

```bash
# Build image
docker build -t iot-dashboard .

# Run container with byte-iot.net
docker run -p 3000:3000 \
  -e MQTT_BROKER_URL=mqtt://byte-iot.net:1883 \
  -e MQTT_USERNAME=your_user \
  -e MQTT_PASSWORD=your_pass \
  iot-dashboard

# Or run with local Mosquitto
docker run -p 3000:3000 \
  -e MQTT_BROKER_URL=mqtt://host.docker.internal:1883 \
  iot-dashboard
```

### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  dashboard:
    build: .
    container_name: iot-dashboard
    ports:
      - "3000:3000"
    environment:
      MQTT_BROKER_URL: mqtt://mosquitto:1883
      MQTT_USERNAME: ${MQTT_USERNAME}
      MQTT_PASSWORD: ${MQTT_PASSWORD}
      DASHBOARD_PORT: 3000
    depends_on:
      - mosquitto
    restart: unless-stopped

  # Optional: local MQTT broker for testing
  mosquitto:
    image: eclipse-mosquitto:latest
    container_name: mosquitto
    ports:
      - "1883:1883"
    volumes:
      - mosquitto_data:/mosquitto/data
      - mosquitto_logs:/mosquitto/log
    restart: unless-stopped

volumes:
  mosquitto_data:
  mosquitto_logs:
```

Run with: `docker-compose up -d`

## Deployment

### Railway.app (Recommended)
1. Push to GitHub
2. Connect repo to Railway
3. Add environment variables
4. Deploy

### Render.com
1. Create new Web Service
2. Connect GitHub repo
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables

### Fly.io
```bash
fly launch
fly deploy
```

## API Endpoints

- `GET /api/devices` - All connected devices
- `GET /api/rfid` - RFID event history
- `GET /api/raw` - Raw message logs
- `GET /api/alerts` - Current active alerts
- `GET /api/export/:stream?format=csv|json` - Export data (heartbeat, wifi, rfid)

**Stream types:** `heartbeat`, `wifi`, `rfid`

## MQTT Message Format

Devices should publish JSON messages:

```json
{
  "deviceId": "device-001",
  "type": "heartbeat|wifi|rfid",
  "battery": 85,
  "signal": -45,
  "timestamp": 1234567890,
  "data": {}
}
```

## Dashboard Sections

- **Devices** - Overview of all connected devices and their status
- **Heartbeats** - Device heartbeat logs with timestamps
- **WiFi Signals** - Signal strength monitoring and history
- **RFID Events** - RFID tag detection logs
- **Alerts** - Current active alerts with auto-refresh
- **Export** - Download historical data as CSV

## Development

```bash
# Install dev dependencies
npm install

# Watch mode (auto-restart on changes)
npm run dev

# Run MQTT client in separate terminal
npm run client
```

## Troubleshooting

**Dashboard won't load**
- Check `MQTT_BROKER_URL` is correct
- Verify broker credentials in `.env`
- Check browser console for errors

**No data appearing**
- Ensure MQTT broker is running
- Verify devices are publishing to subscribed topics
- Check `MQTT_SUBSCRIBE_TOPICS` matches your device topics

**High memory usage**
- Adjust `MAX_HISTORY` in `src/server.js` to limit stored messages
- Enable data export and clear old records

## License

MIT
