# EcoVolt Telemetry Dashboard

Real-time telemetry monitoring for Shell Eco-marathon vehicles. Built with **SolidJS**, **TypeScript**, and **Convex**.

---

## 🚀 Features

| Category | Features |
|----------|----------|
| **Real-time** | Live streaming via Ably + Convex subscriptions |
| **Visualization** | 11 dashboard panels, 60fps charts, interactive maps |
| **Data** | CSV export, quality metrics, outlier detection |
| **Security** | Role-based access (Guest, External, Internal, Admin) |
| **Design** | Dark theme, glassmorphism, responsive |

---

## 📦 Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | SolidJS 1.8, TypeScript 5.7 |
| Build | Vite 5.4 |
| Backend | Convex |
| Charts | uPlot 1.6 |
| Maps | MapLibre GL JS 4.1 |
| Tables | TanStack Table 8.17 |

---

## 🛠️ Quick Start

### Prerequisites

- Node.js 18+
- Convex account ([convex.dev](https://convex.dev))
- Ably account ([ably.com](https://ably.com))

### Installation

```bash
# Clone and install
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Convex URL

# Start development servers
npm run dev          # Frontend (port 3000)
npm run dev:convex   # Convex backend (separate terminal)
```

### Production

```bash
# Build
npm run build

# Deploy Convex
npm run deploy

# Deploy frontend (Vercel)
vercel --prod
```

---

## 📁 Project Structure

```
src/
├── App.tsx           # Main application entry
├── components/
│   ├── auth/         # Auth (Provider, Modals, UserMenu)
│   ├── charts/       # uPlot charts + configs
│   ├── gauges/       # Canvas gauges
│   ├── layout/       # Header, Tabs, Panel
│   ├── map/          # MapLibre components
│   ├── table/        # TanStack Table
│   └── ui/           # Modal, Toast, Button
├── panels/           # 11 dashboard panels
├── stores/           # SolidJS reactive stores
├── lib/              # Convex client, utilities
└── types/            # TypeScript definitions

convex/
├── schema.ts         # Database schema
├── telemetry.ts      # Telemetry queries/mutations
├── sessions.ts       # Session management
├── auth.ts           # Authentication
└── users.ts          # User management
```

---

## 📊 Dashboard Panels

| Panel | Description |
|-------|-------------|
| **Overview** | Gauges + G-force scatter + stats |
| **Speed** | Speed/acceleration analysis |
| **Power** | Power/voltage/current charts |
| **IMU** | Sensor data visualization |
| **Efficiency** | Energy trends + optimal speed |
| **GPS** | Interactive map + altitude |
| **Data** | Raw table + CSV export |
| **Quality** | Data completeness + outliers |
| **Sessions** | Session history |
| **Custom** | User-defined widgets |
| **Admin** | User management |

---

## 🔐 User Roles

| Role | Real-time | Historical | CSV | Admin |
|------|-----------|------------|-----|-------|
| Guest | ✅ | ❌ | ❌ | ❌ |
| External | ✅ | Last session (max 1000 representative points) | Up to 1000 points | ❌ |
| Internal | ✅ | ∞ | ∞ | ❌ |
| Admin | ✅ | ∞ | ∞ | ✅ |

External users do not have access to the Custom Analysis view.

---

## 📚 Documentation

- [CONVEX_SETUP.md](./CONVEX_SETUP.md) - Backend configuration
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
- [SECURITY.md](./SECURITY.md) - Security considerations

---

## 📝 Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run dev:convex` | Start Convex dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview production |
| `npm run deploy` | Deploy Convex |
| `npm run typecheck` | TypeScript check |

---

## 📄 License

MIT License - EcoVolt Shell Eco-marathon Team
