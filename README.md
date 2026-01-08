# 🏎️ Shell Eco-marathon Telemetry Dashboard

A real-time telemetry dashboard for monitoring vehicle performance during Shell Eco-marathon competitions. Built with Express.js, Ably for real-time data streaming, Supabase for data persistence and authentication.

## 🚀 Quick Links

- **[Quick Start Guide](./QUICKSTART.md)** - Deploy to Vercel in 5 minutes
- **[Deployment Guide](./DEPLOYMENT.md)** - Comprehensive deployment instructions
- **[Supabase Setup](./SUPABASE_SETUP.md)** - Authentication setup guide
- **[Local Development](#getting-started)** - Run locally for development

## Features

- 📊 Real-time telemetry monitoring
- 📈 Historical session playback
- 🗺️ GPS tracking with map visualization
- ⚡ Power and efficiency metrics
- 🧭 IMU sensor data visualization
- 📋 Data quality analysis
- 💾 CSV export functionality
- 🔐 **Authentication & Role-Based Access Control**
- 👥 **User Management Dashboard (Admin)**


## User Roles & Permissions

The dashboard supports four user roles with different access levels:

### 🎭 Guest (Default)
- ✅ View real-time telemetry data
- ❌ Cannot download CSV files
- ❌ Cannot view historical sessions

### 🔓 External User
- ✅ View real-time telemetry data
- ✅ Download CSV (up to 400 data points)
- ✅ View last historical session
- ✅ Auto-approved on signup

### 🔒 Internal User
- ✅ View real-time telemetry data
- ✅ Download unlimited CSV data
- ✅ View all historical sessions
- ❌ Cannot access admin dashboard
- ⚠️ Requires admin approval

### 👑 Admin
- ✅ Full access to all features
- ✅ User management dashboard
- ✅ Approve/reject user requests
- ✅ Change user roles

## Tech Stack

- **Backend**: Express.js (Node.js)
- **Real-time**: Ably
- **Database**: Supabase (PostgreSQL)
- **Authentication**: Supabase Auth
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

Create a `.env` file in the root directory (use `.env.example.txt` as a template):

```env
PORT=5173
STATIC_DIR=public

# Ably API key (server side)
ABLY_API_KEY=your_ably_api_key

# Ably channel name (optional)
ABLY_CHANNEL_NAME=telemetry-dashboard-channel

# Supabase project URL
SUPABASE_URL=your_supabase_url

# Supabase anon/public key (safe to expose to frontend)
SUPABASE_ANON_KEY=your_supabase_anon_key

# Supabase service role key (server-side only - KEEP SECRET!)
SUPABASE_SERVICE_ROLE=your_supabase_service_role_key

# Optional: limit rows when scanning for sessions
SESSIONS_SCAN_LIMIT=10000
```

**Note:** The `.env` file should never be committed to version control. It's included in `.gitignore`.

### Authentication Setup

To enable authentication and user management features, you need to set up Supabase Auth:

1. **Create user profiles table**: Run the SQL schema from `SUPABASE_SETUP.md`
2. **Create first admin user**: Sign up through the UI, then manually set role to 'admin' in Supabase
3. **Configure environment variables**: Ensure `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set

For detailed instructions, see **[SUPABASE_SETUP.md](./SUPABASE_SETUP.md)**

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
   - `ABLY_CHANNEL_NAME` (optional)
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE`
   - `SESSIONS_SCAN_LIMIT` (optional)
6. Click "Deploy"

### Environment Variables

Make sure to set the following environment variables in your Vercel project settings:

| Variable | Description | Required |
|----------|-------------|----------|
| `ABLY_API_KEY` | Your Ably API key for real-time messaging | Yes |
| `ABLY_CHANNEL_NAME` | Channel name for Ably (optional) | No (default: telemetry-dashboard-channel) |
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Your Supabase anon/public key | Yes |
| `SUPABASE_SERVICE_ROLE` | Your Supabase service role key | Yes |
| `SESSIONS_SCAN_LIMIT` | Maximum rows to scan when loading sessions | No (default: 10000) |

## Project Structure

```
TelemetryDashboard/
├── public/              # Static frontend files
│   ├── index.html      # Main HTML file
│   ├── app.js          # Frontend JavaScript (fetches config from /api/config)
│   ├── styles.css      # Styling
│   └── config.js       # Deprecated - config now loaded from API
├── index.js            # Express server and API routes
├── vercel.json         # Vercel configuration
├── package.json        # Node.js dependencies
├── .env                # Environment variables (not in git, use placeholders)
├── .env.example.txt    # Environment variables template
└── README.md           # This file
```

## API Endpoints

- `GET /api/health` - Health check endpoint
- `GET /api/config` - Get frontend configuration (secure, from environment variables)
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

### Secure Configuration Architecture

The application uses a secure configuration system:

1. **Environment Variables**: All secrets are stored in environment variables (`.env` for local, Vercel dashboard for production)
2. **API Endpoint**: The `/api/config` endpoint serves safe-to-expose configuration from environment variables
3. **Dynamic Loading**: Frontend fetches configuration from `/api/config` on startup
4. **No Hardcoded Secrets**: No sensitive data is committed to the repository

### Frontend Configuration

Configuration is automatically fetched from `/api/config` endpoint. For local development with custom config:

```javascript
// Define this in index.html BEFORE app.js loads (optional override)
window.CONFIG = {
  ABLY_CHANNEL_NAME: "telemetry-dashboard-channel",
  ABLY_AUTH_URL: "/api/ably/token",
  SUPABASE_URL: "your_supabase_url",
  SUPABASE_ANON_KEY: "your_supabase_anon_key"
};
```

**Note:** This is only needed for custom overrides. In normal operation, configuration is loaded automatically from `/api/config`.

### Backend Configuration

Backend configuration is handled through environment variables in the `.env` file. See `.env.example.txt` for a template.

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
