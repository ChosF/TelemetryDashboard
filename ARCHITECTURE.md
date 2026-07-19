# 🏛️ Architecture Analysis: EcoVolt Telemetry Dashboard

The repository implements a highly decoupled, real-time telemetry processing architecture. The system relies heavily on **Ably** for ultra-low latency Pub/Sub and **Convex** for serverless persistent storage.

## 1. Full Stack Data Flow

The architecture embraces a "Compute ONCE" mindset. Intensive computations are handled by the Python bridge, ensuring web instances act as thin clients that only consume and render data.

```mermaid
flowchart TD
    classDef hardware fill:#f44336,stroke:#fff,color:#fff;
    classDef bridge fill:#ff9800,stroke:#fff,color:#fff;
    classDef backend fill:#9c27b0,stroke:#fff,color:#fff;
    classDef realtime fill:#03a9f4,stroke:#fff,color:#fff;
    classDef frontend fill:#4caf50,stroke:#fff,color:#fff;

    HW[ESP32 Vehicle Controller]:::hardware
    Bridge("Python Telemetry Bridge<br/>(Analyzes & Enriches)"):::bridge
    
    Convex[(Convex Database<br/>Active Session Tail)]:::backend
    ConvexFiles[(Convex File Storage<br/>Gzip Session Archives)]:::backend
    AblyIngest((Ably Inbound Stream<br/>EcoTele Channel)):::realtime
    AblyOutbound((Ably Outbound Stream<br/>Dashboard Channel)):::realtime
    
    General[General Dashboard UI]:::frontend
    Driver[Driver Dashboard UI]:::frontend
    Historical[Historical Dashboard UI]:::frontend

    %% 1. Hardware Origin
    HW -- Raw MQTT Data --> AblyIngest
    
    %% 2. The Python Bridge processing pipeline
    AblyIngest -- Consumes Raw Data --> Bridge
    Bridge -- Batches via API `insertTelemetryBatch` --> Convex
    Convex -- Bounded Inactive-Session Archiver --> ConvexFiles
    Bridge -- Publishes Enriched JSON --> AblyOutbound
    
    %% 3. The Driver Cockpit (Bypasses bridge for absolute minimal latency)
    AblyIngest -- Raw Sub-Millisecond Telemetry --> Driver
    Convex -- Notifications Long-Poll --> Driver
    
    %% 4. The General Dashboard
    AblyOutbound -- Enriched Telemetry Stream --> General
    Convex -- Fetches Session Information Context --> General
    
    %% 5. The Historical Dashboard
    ConvexFiles -- Overview First; Full Parts On Demand --> Historical
    Convex -- Manifest + Active Tail Pagination --> Historical
```

### Key Architectural Concepts
1. **Zero-Processing Latency for Driver:** By having the Driver Dashboard tap straight into the `Ably Inbound Stream` (the exact same channel the ESP32 publishes to), the system completely removes the Python array processing, Z-score calculations, and network hops of the Bridge from the driver's critical path.
2. **Dual-Sourcing for General Dashboard:** The General Dashboard leverages both **Convex** (to load session state and the active database tail upon initialization) and the **Ably Outbound Stream** (to parse the enriched mathematical derivations constructed by `maindata.py`).
3. **Hot/Cold Historical Storage:** Telemetry remains as indexed database documents while a session is active. After 30 minutes of inactivity, a bounded internal cron action writes ordered 3,000-record gzip parts to Convex File Storage, atomically records each part in `telemetryArchives`, and removes the corresponding wide database documents.
4. **Progressive Historical Resolution:** Every archived part also produces a tiny preview and exact aggregate summary. Finalization consolidates them into one gzip overview capped at 1,500 representative points. Opening a session downloads only this overview, and browsing or focusing session cards performs no data fetch. Collapsed modules perform no rendering; charts, energy, driver, map, table preview, and comparisons use overview data; distribution statistics, anomaly analysis, regression, segmentation, custom analysis, and exports request full archive parts only when invoked. Active and not-yet-archived sessions use a bounded 1,500-record database preview rather than a full scan.

---

## 2. Website Architecture

The frontend avoids a monolithic approach, instead opting for purpose-built "instances" depending on the specific use case of the team member.

```mermaid
graph TD
    classDef core fill:#1e1e24,stroke:#00a8ff,stroke-width:2px,color:#fff;
    classDef instance fill:#2d2d38,stroke:#00a8ff,color:#fff;
    classDef module fill:#3a3a4a,stroke:#4caf50,color:#fff;
    classDef external fill:#111,stroke:#f39c12,stroke-width:2px,color:#fff;

    WebFramework[Frontend Setup<br>HTML / Vite]:::core
    
    subgraph Instances[Website Frontends]
        GenDB[General Dashboard <br> vanilla JS `app.js`]:::instance
        HistDB[Historical Dashboard <br> vanilla JS `historical.js`]:::instance
        DrvDB[Driver Dashboard <br> SolidJS `DriverDashboard`]:::instance
    end

    WebFramework --> GenDB
    WebFramework --> HistDB
    WebFramework --> DrvDB
    
    subgraph GenDB_Modules[General Dashboard Modules]
        AblyConn1[Ably Real-time Subscriber]:::module
        GenUI[Real-time Complex Charting]:::module
    end
    GenDB --> GenDB_Modules

    subgraph HistDB_Modules[Historical Dashboard Modules]
        ConvexClient[Convex DB Query Client]:::module
        BatchLoader[Progressive Overview Loader<br/>+ On-Demand Full Hydration]:::module
    end
    HistDB --> HistDB_Modules

    subgraph DrvDB_Modules[Driver Dashboard Modules]
        AblyConn2[Ably Low-Latency Subscriber]:::module
        NotifPoller[Convex Notification Poller]:::module
        SolidUI[High-Performance Reactive UI]:::module
    end
    DrvDB --> DrvDB_Modules

    ABLY((Ably Services)):::external
    CONVEX((Convex Cloud DB)):::external
    
    AblyConn1 <--> ABLY
    AblyConn2 <--> ABLY
    ConvexClient <--> CONVEX
    NotifPoller <--> CONVEX
```

**Instance Workflows:**
*   **General Dashboard (`app.js`):** Engineered for the pit crew. It connects directly to an **Ably** channel (`telemetry-dashboard-channel`). It retains a rolling window of telemetry data tightly coupled with charting libraries to display live anomalies and efficiency metrics. It queries Convex primarily for historical context and session boundaries.
*   **Driver Dashboard (`DriverDashboard.tsx`):** A modern, mobile-optimized UI. It uses **SolidJS** to avoid heavy DOM reconciliations and maintains absolute minimal latency. It uses a **hybrid networking approach**: it connects to **Ably** directly against the inbound stream for instantaneous raw telemetry (speed, G-force, deltas), whilst simultaneously running a lightweight polling function against **Convex** to fetch critical team notifications and flags asynchronously. 
*   **Historical Dashboard (`historical.js`):** Designed for deep, post-race analysis. It drops the Ably WebSocket connection completely and interfaces exclusively with **Convex**. Its default payload is a single compressed level-of-detail overview with exact session KPIs. Full gzip parts remain available for operations that need every sample, but are hydrated once and only on explicit demand. Cursor pagination remains as a deployment-compatibility fallback; normal session opens never scan the full telemetry table.

---

## 3. Backend Architecture (`maindata.py`)

The backend focuses on high-frequency stream processing. Instead of the vehicle talking directly to a database, it talks to a "Bridge" constructed in Python (`maindata.py`), which orchestrates data enhancement before it hits the clients.

```mermaid
graph TD
    classDef process fill:#2d2d38,stroke:#ff5722,stroke-width:2px,color:#fff;
    classDef component fill:#3a3a4a,stroke:#4caf50,color:#fff;
    classDef external fill:#111,stroke:#f39c12,stroke-width:2px,color:#fff;

    Bridge[maindata.py<br>Python Telemetry Bridge]:::process
    
    subgraph BridgeComponents[Bridge Core Modules]
        Receiver[Ably `EcoTele`<br>Ingest Channel]:::component
        Calc[TelemetryCalculator<br>Efficiency, G-Force, Motion State]:::component
        Outlier[OutlierDetector<br>Z-Score Configs & Stuck Sensors]:::component
        Batcher[Convex Muxer/Batch Uploader]:::component
        Publisher[Ably `telemetry-dashboard`<br>Publish Channel]:::component
    end

    BRIDGE_IN((Ably / ESP32 Input)):::external
    ABLY_OUT((Ably Dashboard Out)):::external
    CONVEX_OUT((Convex Hosted API)):::external

    BRIDGE_IN -->|Raw Sensor JSON| Receiver
    Receiver --> Bridge
    Bridge --> Calc
    Calc --> Outlier
    Outlier -->|Enriched Data Dictionary| Bridge
    
    Bridge --> Publisher
    Bridge --> Batcher
    
    Publisher -->|Sub-200ms Latency| ABLY_OUT
    Batcher -->|Periodic HTTP Batches| CONVEX_OUT
```

**Backend Modules:**
*   **Ingestion:** The Bridge listens to the raw ESP32 data entering via **Ably** (`EcoTele` channel). 
*   **Real-time Calculations (`TelemetryCalculator`):** Rather than forcing mobile browsers to run math, the Python bridge offloads the work. It takes raw speeds and currents and actively computes the motion state (cruising, braking), active G-force estimates, cumulative energy, and optimal speed efficiencies in rolling arrays.
*   **Anomaly Detection (`OutlierDetector`):** It runs NumPy-based statistical analysis across rolling windows, checking for erratic jumps, impossible GPS positions, and explicitly marks `outliers` with severity keys before transmitting.
*   **Separation of Duties:** 
    *   **Live Path:** The mutated JSON data is instantly republished to a *different* **Ably** channel meant for consumption by the UI instances (e.g. General Dashboard).
    *   **Cold Path:** The exact same enhanced arrays are queued, throttled into batches, and pushed out to **Convex** via `insertTelemetryBatch` to securely mutate the serverless document graph continuously.
