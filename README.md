# EcoVolt Telemetry Dashboard

Real-time telemetry monitoring dashboard for Shell Eco-marathon vehicles. Built with **SolidJS**, **TypeScript**, and **Convex**.

## 🚀 Features

- **Real-time Data**: Live telemetry streaming via Convex
- **11 Dashboard Panels**: Overview, Speed, Power, IMU, Efficiency, GPS, Data, Quality, Sessions, Custom, Admin
- **High-Performance Charts**: uPlot for 60fps rendering with 10k+ points
- **Interactive Map**: MapLibre GL JS with GPS track visualization
- **Canvas Gauges**: Smooth analog gauges for speed, battery, power, efficiency
- **Data Export**: CSV export with TanStack Table
- **Role-Based Access**: Guest, External, Internal, Admin roles
- **Dark Theme**: Premium glassmorphism design

## 📦 Tech Stack

| Category | Technology |
|----------|------------|
| Framework | SolidJS 1.9 |
| Language | TypeScript 5.6 |
| Build | Vite 6.0 |
| Backend | Convex |
| Charts | uPlot 1.6 |
| Maps | MapLibre GL JS 4.1 |
| Tables | TanStack Table 8 |

## 🛠️ Setup

### Prerequisites
- Node.js 18+
- npm or pnpm
- Convex account

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Edit .env.local with your Convex URL
# VITE_CONVEX_URL=https://your-deployment.convex.cloud
```

### Development

```bash
# Start dev server
npm run dev

# Open http://localhost:3000
```

### Production Build

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

## 📁 Project Structure

```
src/
├── components/
│   ├── auth/       # Auth components (Provider, Modals, UserMenu)
│   ├── charts/     # uPlot chart components and configs
│   ├── gauges/     # Canvas gauge components
│   ├── layout/     # Layout components (Header, Tabs, Panel)
│   ├── map/        # MapLibre components
│   ├── table/      # TanStack Table components
│   └── ui/         # UI components (Modal, Toast)
├── lib/            # Utilities (convex client, helpers)
├── panels/         # Dashboard panel components
├── services/       # External service integrations
├── stores/         # SolidJS reactive stores
├── styles/         # Global CSS
├── types/          # TypeScript type definitions
└── workers/        # Web Worker for data processing
```

## 🔐 User Roles

| Role | Real-time | Historical | CSV Export | Admin |
|------|-----------|------------|------------|-------|
| Guest | ✅ | ❌ | ❌ | ❌ |
| External | ✅ | 7 days | 1k rows | ❌ |
| Internal | ✅ | ∞ | ∞ | ❌ |
| Admin | ✅ | ∞ | ∞ | ✅ |

## 📊 Panels

| Panel | Description |
|-------|-------------|
| Overview | Key metrics with gauges and G-force scatter |
| Speed | Speed/acceleration charts and statistics |
| Power | Power, voltage, current, and energy analysis |
| IMU | Accelerometer, gyroscope, orientation data |
| Efficiency | Energy efficiency trends and comparisons |
| GPS | Map visualization with altitude and speed |
| Data | Raw telemetry table with export |
| Quality | Data completeness and outlier detection |
| Sessions | Session history and selection |
| Custom | User-customizable widget dashboard |
| Admin | User management and approvals |

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_CONVEX_URL` | Convex deployment URL | ✅ |
| `VITE_MAPTILER_KEY` | MapTiler API key for custom styles | ❌ |
| `VITE_DEBUG` | Enable debug logging | ❌ |

## 📝 License

MIT License - Shell Eco-marathon Team
