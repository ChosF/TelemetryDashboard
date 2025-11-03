# 🏎️ Shell Eco-marathon Telemetry Dashboard

A real-time telemetry dashboard for monitoring vehicle performance during Shell Eco-marathon competitions. Built with Express.js, Ably for real-time data streaming, and Supabase for data persistence.

## Features

- 📊 Real-time telemetry monitoring
- 📈 Historical session playback
- 🗺️ GPS tracking with map visualization
- ⚡ Power and efficiency metrics
- 🧭 IMU sensor data visualization
- 📋 Data quality analysis
- 💾 CSV export functionality

## Tech Stack

- **Backend**: Express.js (Node.js)
- **Real-time**: Ably
- **Database**: Supabase
- **Frontend**: Vanilla JavaScript with ECharts, Leaflet, DataTables
- **Deployment**: Vercel

## Getting Started

### Prerequisites

- Node.js 18.x or higher
- npm or yarn
- Ably account (for real-time messaging)
- Supabase project (for data storage)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/ChosF/TelemetryDashboard.git
cd TelemetryDashboard
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:

Create a `.env` file in the root directory:

```env
PORT=5173
STATIC_DIR=public

# Ably API key (server side)
ABLY_API_KEY=your_ably_api_key

# Supabase project URL
SUPABASE_URL=your_supabase_url

# Supabase service role key (server-side only)
SUPABASE_SERVICE_ROLE=your_supabase_service_role_key

# Optional: limit rows when scanning for sessions
SESSIONS_SCAN_LIMIT=10000
```

4. Run the development server:
```bash
npm run dev
```

The application will be available at `http://localhost:5173`

## Deployment to Vercel

This application is fully configured for deployment on Vercel.

### Deploy with Vercel CLI

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Deploy:
```bash
vercel
```

3. Follow the prompts to configure your project.

### Deploy with Vercel Dashboard

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Click "New Project"
4. Import your GitHub repository
5. Configure environment variables in the Vercel dashboard:
   - `ABLY_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE`
   - `SESSIONS_SCAN_LIMIT` (optional)
6. Click "Deploy"

### Environment Variables

Make sure to set the following environment variables in your Vercel project settings:

| Variable | Description | Required |
|----------|-------------|----------|
| `ABLY_API_KEY` | Your Ably API key for real-time messaging | Yes |
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_SERVICE_ROLE` | Your Supabase service role key | Yes |
| `SESSIONS_SCAN_LIMIT` | Maximum rows to scan when loading sessions | No (default: 10000) |

## Project Structure

```
TelemetryDashboard/
├── public/              # Static frontend files
│   ├── index.html      # Main HTML file
│   ├── app.js          # Frontend JavaScript
│   ├── styles.css      # Styling
│   └── config.js       # Frontend configuration
├── index.js            # Express server and API routes
├── vercel.json         # Vercel configuration
├── package.json        # Node.js dependencies
├── .env                # Environment variables (not in git)
├── .env.example.txt    # Environment variables template
└── README.md           # This file
```

## API Endpoints

- `GET /api/health` - Health check endpoint
- `GET /api/ably/token` - Get Ably authentication token
- `GET /api/sessions` - List available telemetry sessions
- `GET /api/sessions/:session_id/records` - Get records for a specific session

## Local Development

Run the development server:
```bash
npm run dev
```

The server will start on port 5173 (or the port specified in your `.env` file).

## Configuration

### Frontend Configuration

Edit `public/config.js` to configure the frontend:

```javascript
window.CONFIG = {
  ABLY_CHANNEL_NAME: "telemetry-dashboard-channel",
  ABLY_AUTH_URL: "/api/ably/token",
  SUPABASE_URL: "your_supabase_url",
  SUPABASE_ANON_KEY: "your_supabase_anon_key"
};
```

### Backend Configuration

Backend configuration is handled through environment variables in the `.env` file.

## Troubleshooting

### Port Already in Use

If port 5173 is already in use, change the `PORT` variable in your `.env` file:
```env
PORT=3000
```

### Ably Connection Issues

Make sure your `ABLY_API_KEY` is correctly set in the `.env` file and that you have an active Ably account.

### Supabase Connection Issues

Verify that:
1. Your `SUPABASE_URL` is correct
2. Your `SUPABASE_SERVICE_ROLE` key is valid
3. Your Supabase project has a `telemetry` table with the appropriate schema

## License

This project is private and not licensed for public use.

## Support

For questions or issues, please contact the repository maintainer.
