# GHOST — Phase 1: Deterministic Browser Execution

This is theแรก (first) functional vertical slice of the GHOST agent.

## Features
- **Deterministic Workflow**: Navigates to a local demo target, captures a screenshot, and persists everything.
- **Task Management**: Create tasks, track status (IDLE $\rightarrow$ EXECUTING $\rightarrow$ COMPLETED), and view execution history.
- **Real-time Dashboard**: A dark-themed Next.js interface to monitor tasks and view captured visual evidence.
- **Secure Browser Execution**: Playwright-based browser with origin restrictions.

## Prerequisites
- Node.js (v18+)
- npm

## Setup & Running

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Generate Prisma Client**:
   ```bash
   npx prisma generate
   ```

3. **Initialize Database**:
   ```bash
   npx prisma migrate dev --name init
   ```

4. **Start the Demo Target**:
   Open a terminal and run:
   ```bash
   node demo_target.js
   ```
   (This will run on `http://127.0.0.1:3001`)

5. **Start the GHOST Server**:
   Open a new terminal and run:
   ```bash
   npm run dev:server
   ```
   (This will run on `http://localhost:3002`)

6. **Start the GHOST Dashboard**:
   Open a new terminal and run:
   ```bash
   npm run dev:web
   ```
   (This will run on `http://localhost:3000`)

7. **Access the Dashboard**:
   Navigate to `http://localhost:3000` and click "Start Demo Task".

## Architecture
- **Frontend**: Next.js (App Router)
- **Backend**: Fastify
- **Automation**: Playwright
- **Database**: SQLite (via Prisma)
- **Storage**: Local filesystem for screenshots
