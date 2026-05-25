# Realtime Code Editor Server

Small Node.js, Express, Socket.io, and TypeScript backend for a real-time collaborative code editor.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

The server runs on `http://localhost:4000` by default.

## Redis Socket.IO Scaling

Socket.IO can use Redis Pub/Sub so multiple backend instances share room broadcasts.

```bash
REDIS_URL=redis://localhost:6379
```

Start Redis before the server to enable cross-instance room events. If Redis is unavailable, the server logs the exact connection error and continues in single-instance Socket.IO mode.

## Database Persistence

Persistence uses PostgreSQL. Active collaboration still runs from in-memory room state; PostgreSQL is used to reload the latest workspace after the server restarts or a room becomes inactive.

1. Start a local PostgreSQL instance.
2. Create a database named `realtime_code_editor`.
3. Copy `.env.example` to `.env`.
4. Set the database values:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/realtime_code_editor
AUTOSAVE_DEBOUNCE_MS=1000
```

The server creates the `workspaces` table automatically:

```sql
create table if not exists workspaces (
  room_id text primary key,
  files jsonb not null,
  project_tree jsonb not null default '[]'::jsonb,
  active_file_name text not null,
  active_file jsonb,
  updated_at timestamptz not null default now()
);
```

If PostgreSQL is unavailable, the server still starts and rooms use the default in-memory files. Persistence resumes after a valid `DATABASE_URL` connection is available and the server is restarted.

Each saved workspace document contains:

```json
{
  "roomId": "team-room",
  "activeFileName": "main.ts",
  "activeFile": {
    "fileName": "main.ts",
    "code": "...",
    "language": "typescript",
    "version": 2,
    "updatedAt": "2026-05-24T00:00:00.000Z"
  },
  "projectTree": [
    {
      "id": "src",
      "type": "folder",
      "name": "src",
      "path": "src",
      "children": [
        {
          "id": "src/main.ts",
          "type": "file",
          "name": "main.ts",
          "path": "src/main.ts"
        }
      ]
    }
  ],
  "files": [
    {
      "fileName": "main.ts",
      "code": "...",
      "language": "typescript",
      "version": 2,
      "updatedAt": "2026-05-24T00:00:00.000Z"
    }
  ],
  "updatedAt": "2026-05-24T00:00:00.000Z"
}
```

## Build and Start

```bash
npm run build
npm start
```

## Health Check

```bash
GET http://localhost:4000/health
```

Returns:

```json
{ "status": "ok" }
```

## Code Execution

The server sends code to Judge0 through `POST /execute`.

Optional `.env` value:

```bash
JUDGE0_API_URL=https://ce.judge0.com
```

## Socket Events

- `join-room`: joins a room and updates active users for that room.
- `code-change`: broadcasts code changes to other users in the same room.
- `language-change`: updates a file language and resets its starter code.
- `project-create`: creates a file or folder in the project tree.
- `project-rename`: renames a file or folder and updates nested paths.
- `project-delete`: deletes a file or folder.
- `project-upload`: replaces the room workspace with an uploaded text/code folder snapshot.
- `project-update`: broadcasts the latest project tree and files after project changes.
- `manual-save`: immediately persists the active room workspace to PostgreSQL.
- `autosave-status`: emitted by the server as `saving`, `saved`, or `failed`.
- `disconnect`: removes the socket from any joined rooms and updates active users.
