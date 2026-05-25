# 🚀 CollabCode — Real-Time Collaborative Code Editor

A distributed real-time collaborative code editor inspired by VS Code and Replit, built with React, Node.js, Socket.IO, PostgreSQL, and Redis.

CollabCode enables multiple users to collaborate on shared workspaces with real-time synchronization, Operational Transformation (OT), cursor presence, persistent workspaces, secure invite-based rooms, and collaborative project editing.

---

## Screenshots

| Login | Workspace | Invite Room |
| --- | --- | --- |
|<img width="1915" height="1015" alt="image" src="https://github.com/user-attachments/assets/2bf6e3e6-ecb6-4977-a24f-ed2956f1c8f0" />| <img width="1918" height="1018" alt="image" src="https://github.com/user-attachments/assets/ddf29170-b6a3-40c2-bac4-ce8054059bc6" />| <img width="941" height="647" alt="Screenshot 2026-05-25 161316" src="https://github.com/user-attachments/assets/c5019d34-05e2-421c-bf53-0bfaf1d068e3" />|

## Features

- Real-time collaborative editing with Socket.IO
- Operational Transformation for concurrent text edits
- Monaco Editor syntax highlighting
- Multi-file workspace with file and folder explorer
- Create, rename, delete, and switch files
- Upload a local project folder
- Cursor presence with collaborator initials
- Typing presence
- Autosave and manual save
- PostgreSQL workspace persistence
- Redis Pub/Sub adapter for Socket.IO scaling
- JWT authentication with bcrypt password hashing
- Private rooms with secure invite tokens
- User-based recent workspace history
- Code execution through Judge0-compatible API
- Light, modern editor UI with output panel

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React, Vite, TypeScript |
| Editor | Monaco Editor |
| Backend | Node.js, Express, TypeScript |
| Realtime | Socket.IO |
| Auth | JWT, bcrypt |
| Database | PostgreSQL |
| Scaling | Redis, `@socket.io/redis-adapter` |
| Code Execution | Judge0-compatible execution API |

## Architecture

```text
client/
  React + Vite + Monaco Editor
  Socket.IO client
  Authenticated dashboard and workspace UI

server/
  Express REST API
  Socket.IO realtime server
  Operational Transformation engine
  PostgreSQL persistence
  Redis Socket.IO adapter
```

High-level flow:

1. A user registers or logs in and receives a JWT.
2. The frontend uses the JWT for protected REST routes and Socket.IO authentication.
3. Users create or join private rooms with secure invite tokens.
4. The server loads the workspace from PostgreSQL or creates a default workspace.
5. Editor changes are sent as operations over Socket.IO.
6. The server applies or transforms operations, updates room state, broadcasts changes, and schedules persistence.
7. Redis Pub/Sub allows multiple backend instances to share Socket.IO events.

## Real-Time Collaboration

Each room keeps an active in-memory workspace state on the server. When a user edits code, the frontend sends a structured edit operation over Socket.IO. The server validates the room, file, version, and operation before applying it.

The server then broadcasts the accepted update to all room members. Cursor positions, typing presence, active users, file tree updates, language changes, and execution output use the same authenticated room channel.

## Operational Transformation

CollabCode uses Operational Transformation to handle concurrent edits safely.

Each file has:

- a document version
- an operation history
- insert/delete operations

When an operation arrives with an older base version, the server transforms it against operations that have already been applied. If the operation can be transformed safely, it is applied and broadcast. If it cannot, the client receives a fallback resync with the latest document state.

This keeps collaborators aligned even when they type at the same time.

## Redis Scaling

Socket.IO rooms work in-memory on one process by default. To scale across multiple backend instances, CollabCode uses Redis through `@socket.io/redis-adapter`.

Redis Pub/Sub allows Socket.IO events from one server instance to reach clients connected to other instances. This is important when deploying behind a load balancer or running multiple Node.js processes.

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL
- Redis
- npm

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd Realtime

cd server
npm install

cd ../client
npm install
```

### 2. PostgreSQL

Create a database:

```sql
CREATE DATABASE realtime_code_editor;
```

The backend creates required tables automatically on startup:

- `workspaces`
- `room_access`
- `users`
- `user_rooms`

### 3. Redis

Run Redis locally:

```bash
redis-server
```

Or use Docker:

```bash
docker run --name collabcode-redis -p 6379:6379 redis:latest
```

### 4. Backend Environment

Create `server/.env`:

```env
NODE_ENV=development
PORT=4000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:5175
DATABASE_URL=postgres://postgres:your_password@127.0.0.1:5432/realtime_code_editor
DATABASE_SSL=false
REDIS_URL=redis://localhost:6379
JUDGE0_API_URL=https://ce.judge0.com
AUTOSAVE_DEBOUNCE_MS=1000
JWT_SECRET=change_me_in_dev
SOCKET_IO_PING_TIMEOUT_MS=30000
SOCKET_IO_PING_INTERVAL_MS=25000
SOCKET_IO_RECOVERY_MS=120000
```

For production, replace `JWT_SECRET` with a strong secret.

### 5. Frontend Environment

Create `client/.env`:

```env
VITE_BACKEND_URL=http://localhost:4000
VITE_WEBSOCKET_URL=http://localhost:4000
```

### 6. Run Backend

```bash
cd server
npm run dev
```

Backend runs on:

```text
http://localhost:4000
```

### 7. Run Frontend

```bash
cd client
npm run dev
```

Frontend runs on Vite, usually:

```text
http://localhost:5173
```

If that port is busy, Vite will choose the next available port.

## Production Deployment

### Frontend on Vercel

1. Create a Vercel project from the repository.
2. Set the root directory to `client`.
3. Use the default build command:

```bash
npm run build
```

4. Set output directory:

```text
dist
```

5. Add environment variables:

```env
VITE_BACKEND_URL=https://your-backend.example.com
VITE_WEBSOCKET_URL=https://your-backend.example.com
```

### Backend on Render or Railway

1. Create a Node.js service.
2. Set the root directory to `server`.
3. Set build command:

```bash
npm install && npm run build
```

4. Set start command:

```bash
npm start
```

5. Add environment variables:

```env
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://your-frontend.vercel.app
CORS_ORIGINS=https://your-frontend.vercel.app
DATABASE_URL=postgres://...
DATABASE_SSL=true
REDIS_URL=rediss://...
JWT_SECRET=<strong-random-secret>
JUDGE0_API_URL=https://ce.judge0.com
AUTOSAVE_DEBOUNCE_MS=1000
SOCKET_IO_PING_TIMEOUT_MS=30000
SOCKET_IO_PING_INTERVAL_MS=25000
SOCKET_IO_RECOVERY_MS=120000
```

Render and Railway usually inject `PORT`; leave the code using `process.env.PORT`.

### PostgreSQL on Neon

1. Create a Neon project.
2. Copy the pooled or direct PostgreSQL connection string.
3. Set it as `DATABASE_URL` on the backend service.
4. Set `DATABASE_SSL=true`.

The backend creates tables automatically on startup:

- `workspaces`
- `room_access`
- `users`
- `user_rooms`

### Redis on Upstash

1. Create an Upstash Redis database.
2. Copy the Redis connection URL.
3. Set it as `REDIS_URL` on the backend service.
4. Use `rediss://` when Upstash provides TLS.

Redis powers Socket.IO scaling through Pub/Sub. If Redis is temporarily unavailable, the backend continues running with single-instance Socket.IO behavior and logs the Redis error.

### Health Check

The backend exposes:

```text
GET /health
```

The response includes service status, environment, PostgreSQL status, Redis status, and uptime. Configure Render/Railway health checks to call `/health`.

### Production Notes

- Set `JWT_SECRET` to a strong random value.
- Set `CORS_ORIGINS` to the deployed frontend domain only.
- Set `FRONTEND_URL` to the public frontend URL so invite links point to the deployed app.
- Use `VITE_BACKEND_URL` and `VITE_WEBSOCKET_URL` in Vercel instead of hardcoded URLs.
- Use `DATABASE_SSL=true` for managed PostgreSQL providers such as Neon.
- Use `rediss://` Redis URLs when the provider requires TLS.
- Keep `.env` files out of git.

## Usage

1. Register or log in.
2. Create a private room with a display name.
3. Copy the invite link or invite token.
4. Share it with another logged-in user.
5. Collaborate in real time.
6. Use Run Code to execute supported languages.
7. Reopen recent rooms from the authenticated dashboard.

## Code Execution

Code execution is routed through a Judge0-compatible API. Supported execution languages include:

- JavaScript
- TypeScript
- Python
- Java
- C++

File extensions determine the language used for syntax highlighting and execution.

## Security Notes

- Passwords are hashed with bcrypt.
- JWTs are required for protected REST routes.
- Socket.IO connections require JWT authentication.
- Rooms are private and require secure invite tokens or exact secure room IDs.
- Password hashes are never returned to the frontend.
- `.env` files should never be committed.

## Future Improvements

- Production deployment guide
- Docker Compose for PostgreSQL, Redis, backend, and frontend
- Role-based room permissions
- Room owners and member management
- Invite expiration and revocation
- Password reset flow
- Email verification
- Rate limiting for auth routes
- Persistent terminal sessions
- More language runtimes and package support
- Snapshot/version history
- Comments and annotations
- End-to-end tests

## Author

Prachi Bhavsar

MS Information Technology @ Arizona State University
