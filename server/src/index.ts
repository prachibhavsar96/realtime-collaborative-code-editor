import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import http from "http";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { createClient, RedisClientType } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server, Socket } from "socket.io";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PORT = Number(process.env.PORT) || 4000;
const NODE_ENV = process.env.NODE_ENV?.trim() || "development";
const isProduction = NODE_ENV === "production";
const JUDGE0_API_URL = (process.env.JUDGE0_API_URL || "https://ce.judge0.com").replace(/\/$/, "");
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const REDIS_URL = process.env.REDIS_URL?.trim() || "redis://localhost:6379";
const JWT_SECRET = process.env.JWT_SECRET?.trim() || "change_me_in_dev";
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
const allowedOrigins = (process.env.CORS_ORIGINS || [
  FRONTEND_URL,
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176"
].join(","))
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

const logInfo = (...args: unknown[]) => {
  if (!isProduction) {
    console.log(...args);
  }
};

if (isProduction) {
  console.log = () => undefined;
}

type RoomUser = {
  socketId: string;
  username?: string;
};

type JoinRoomPayload = {
  roomId?: string;
  inviteToken?: string;
  username?: string;
};

type CreateRoomPayload = {
  displayName?: string;
};

type ResolveRoomPayload = {
  accessCode?: string;
};

type AuthPayload = {
  username?: string;
  password?: string;
};

type CodeChangePayload = {
  roomId: string;
  fileName: string;
  username?: string;
  baseVersion: number;
  type: "insert" | "delete";
  position: number;
  text?: string;
  length?: number;
};

type SyncStatus = "Applied" | "Transformed" | "Fallback Resync";

type RoomPayload = {
  roomId: string;
  fileName?: string;
  username?: string;
};

type ManualSavePayload = {
  roomId: string;
};

type ProjectNodeType = "file" | "folder";

type ProjectTreeNode = {
  id: string;
  type: ProjectNodeType;
  name: string;
  path: string;
  children?: ProjectTreeNode[];
};

type ProjectCreatePayload = {
  roomId: string;
  parentPath?: string;
  parentFolderPath?: string;
  selectedFolderPath?: string;
  type: ProjectNodeType;
  name: string;
};

type ProjectRenamePayload = {
  roomId: string;
  path: string;
  name: string;
};

type ProjectDeletePayload = {
  roomId: string;
  path: string;
};

type UploadedProjectFile = {
  fileName: string;
  code: string;
};

type ProjectUploadPayload = {
  roomId: string;
  files: UploadedProjectFile[];
  projectTree: ProjectTreeNode[];
};

type CursorPositionPayload = {
  roomId: string;
  fileName: string;
  username?: string;
  lineNumber: number;
  column: number;
};

type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "cpp"
  | "html"
  | "css"
  | "json"
  | "plaintext";

type LanguageChangePayload = {
  roomId: string;
  fileName: string;
  language: SupportedLanguage;
};

type ExecuteCodePayload = {
  roomId?: string;
  fileName?: string;
  username?: string;
  language: SupportedLanguage;
  code: string;
};

type Judge0Response = {
  stdout: string | null;
  stderr: string | null;
  compile_output: string | null;
  message: string | null;
  time: string | null;
  memory: number | null;
  status?: {
    id: number;
    description: string;
  };
};

type RoomState = {
  users: Map<string, RoomUser>;
  typingUsers: Set<string>;
  cursorPositions: Map<string, CursorPosition>;
  execution: ExecutionState;
  files: Map<string, WorkspaceFile>;
  projectTree: ProjectTreeNode[];
  activeFileName: string;
};

type ExecutionState = {
  output: string;
  error: string;
  status: string;
  roomId?: string;
  fileName?: string;
  username?: string;
};

type WorkspaceFile = {
  fileName: string;
  language: SupportedLanguage;
  code: string;
  version: number;
  operationHistory: TextOperation[];
};

type PersistedWorkspaceFile = {
  fileName: string;
  language: SupportedLanguage;
  code: string;
  version: number;
  updatedAt: Date;
};

type PersistedWorkspace = {
  roomId: string;
  files: PersistedWorkspaceFile[];
  projectTree: ProjectTreeNode[];
  activeFileName: string;
  activeFile: PersistedWorkspaceFile | null;
  updatedAt: Date;
};

type PersistedWorkspaceRow = {
  room_id: string;
  files: PersistedWorkspaceFile[];
  project_tree?: ProjectTreeNode[] | null;
  active_file_name: string;
  active_file: PersistedWorkspaceFile | null;
  updated_at: Date;
};

type RoomAccess = {
  roomId: string;
  displayName: string;
  inviteToken: string;
  createdAt: Date;
};

type RoomAccessRow = {
  room_id: string;
  display_name: string;
  invite_token: string;
  created_at: Date;
};

type AuthUser = {
  id: number;
  username: string;
};

type JwtPayload = {
  userId: number;
  username: string;
};

type AuthenticatedRequest = Request & {
  user?: AuthUser;
};

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: Date;
};

type UserRoomRow = {
  id: number;
  user_id: number;
  room_id: string;
  display_name: string;
  invite_token: string;
  last_opened: Date;
};

type LoadedWorkspace = {
  files: WorkspaceFile[];
  projectTree: ProjectTreeNode[];
  activeFileName: string;
};

type AutosaveState = "saving" | "saved" | "failed";

type CursorPosition = {
  socketId: string;
  username: string;
  fileName: string;
  lineNumber: number;
  column: number;
};

type TextOperation = {
  roomId: string;
  fileName: string;
  username?: string;
  baseVersion: number;
  appliedVersion: number;
  type: "insert" | "delete";
  position: number;
  text: string;
  length: number;
};

const maxOperationHistory = 200;
const autosaveDebounceMs = Number(process.env.AUTOSAVE_DEBOUNCE_MS) || 1000;
const maxUploadedFileBytes = 1024 * 1024;
const maxUploadedFiles = 500;

const starterCodeByLanguage: Record<SupportedLanguage, string> = {
  typescript: `function helloRoom(name: string) {
  return \`Hello, \${name}!\`;
}

console.log(helloRoom("collaborators"));
`,
  javascript: `function helloRoom(name) {
  return \`Hello, \${name}!\`;
}

console.log(helloRoom("collaborators"));
`,
  python: `def hello_room(name):
    return f"Hello, {name}!"


print(hello_room("collaborators"))
`,
  java: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, collaborators!");
    }
}
`,
  cpp: `#include <iostream>
#include <string>

std::string helloRoom(const std::string& name) {
    return "Hello, " + name + "!";
}

int main() {
    std::cout << helloRoom("collaborators") << std::endl;
    return 0;
}
`
,
  html: `<!doctype html>
<html>
  <head>
    <title>Collaborative page</title>
  </head>
  <body>
    <h1>Hello, collaborators!</h1>
  </body>
</html>
`,
  css: `body {
  font-family: system-ui, sans-serif;
  margin: 2rem;
}
`,
  json: `{
  "name": "collaborative-project"
}
`,
  plaintext: ""
};

const judge0LanguageIds: Partial<Record<SupportedLanguage, number>> = {
  javascript: 63,
  typescript: 74,
  python: 71,
  java: 62,
  cpp: 54
};

const defaultWorkspaceFiles: WorkspaceFile[] = [
  {
    fileName: "src/main.ts",
    language: "typescript",
    code: starterCodeByLanguage.typescript,
    version: 1,
    operationHistory: []
  },
  {
    fileName: "app.py",
    language: "python",
    code: starterCodeByLanguage.python,
    version: 1,
    operationHistory: []
  },
  {
    fileName: "src/script.js",
    language: "javascript",
    code: starterCodeByLanguage.javascript,
    version: 1,
    operationHistory: []
  }
];

const defaultProjectTree: ProjectTreeNode[] = [
  {
    id: "src",
    type: "folder",
    name: "src",
    path: "src",
    children: [
      {
        id: "src/main.ts",
        type: "file",
        name: "main.ts",
        path: "src/main.ts"
      },
      {
        id: "src/script.js",
        type: "file",
        name: "script.js",
        path: "src/script.js"
      }
    ]
  },
  {
    id: "app.py",
    type: "file",
    name: "app.py",
    path: "app.py"
  }
];

const app = express();
const server = http.createServer(app);
const corsOptions = {
  origin: allowedOrigins,
  credentials: true
};
const io = new Server(server, {
  cors: {
    ...corsOptions,
    methods: ["GET", "POST", "DELETE"]
  },
  transports: ["websocket", "polling"],
  pingTimeout: Number(process.env.SOCKET_IO_PING_TIMEOUT_MS) || 30000,
  pingInterval: Number(process.env.SOCKET_IO_PING_INTERVAL_MS) || 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: Number(process.env.SOCKET_IO_RECOVERY_MS) || 120000,
    skipMiddlewares: false
  }
});

const rooms = new Map<string, RoomState>();
const roomLoadPromises = new Map<string, Promise<RoomState>>();
const autosaveTimers = new Map<string, NodeJS.Timeout>();
let databasePool: Pool | null = null;
let persistenceAvailable = false;
let persistenceUnavailableReason = "PostgreSQL connection has not been initialized.";
let redisPubClient: RedisClientType | null = null;
let redisSubClient: RedisClientType | null = null;
let databaseReconnectTimer: NodeJS.Timeout | null = null;

app.use(
  cors(corsOptions)
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    environment: NODE_ENV,
    postgres: persistenceAvailable ? "connected" : "unavailable",
    redis: redisPubClient && redisSubClient ? "connected" : "unavailable",
    uptime: process.uptime()
  });
});

const sanitizeUsername = (username?: string) => username?.trim().toLowerCase() ?? "";

const validateAuthPayload = ({ username, password }: AuthPayload) => {
  const nextUsername = sanitizeUsername(username);
  if (!nextUsername || nextUsername.length < 2 || nextUsername.length > 40) {
    return { error: "Username must be 2-40 characters.", username: nextUsername };
  }

  if (!password || password.length < 6) {
    return { error: "Password must be at least 6 characters.", username: nextUsername };
  }

  return { username: nextUsername };
};

const signAuthToken = (user: AuthUser) =>
  jwt.sign({ userId: user.id, username: user.username } satisfies JwtPayload, JWT_SECRET, {
    expiresIn: "7d"
  });

const verifyAuthToken = (token?: string): AuthUser | null => {
  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<JwtPayload>;
    if (!payload.userId || !payload.username) {
      return null;
    }
    return {
      id: payload.userId,
      username: payload.username
    };
  } catch {
    return null;
  }
};

const getBearerToken = (req: Request) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.slice("Bearer ".length).trim();
};

const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const user = verifyAuthToken(getBearerToken(req));
  if (!user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  req.user = user;
  next();
};

app.post("/auth/register", async (req, res) => {
  const pool = requireDatabase(res);
  if (!pool) {
    return;
  }

  const { username, password } = req.body as AuthPayload;
  const validation = validateAuthPayload({ username, password });
  if (validation.error || !password) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query<UserRow>(
      `
        insert into users (username, password_hash)
        values ($1, $2)
        returning id, username, password_hash, created_at
      `,
      [validation.username, passwordHash]
    );
    const user = { id: result.rows[0].id, username: result.rows[0].username };
    res.status(201).json({ token: signAuthToken(user), user });
  } catch (error) {
    if (getErrorMessage(error).includes("duplicate key")) {
      res.status(409).json({ error: "Username already exists." });
      return;
    }
    console.error("register failed", error);
    res.status(500).json({ error: "Could not register user." });
  }
});

app.post("/auth/login", async (req, res) => {
  const pool = requireDatabase(res);
  if (!pool) {
    return;
  }

  const { username, password } = req.body as AuthPayload;
  const nextUsername = sanitizeUsername(username);
  if (!nextUsername || !password) {
    res.status(400).json({ error: "Username and password are required." });
    return;
  }

  try {
    const result = await pool.query<UserRow>(
      "select id, username, password_hash, created_at from users where username = $1",
      [nextUsername]
    );
    const userRow = result.rows[0];
    if (!userRow || !(await bcrypt.compare(password, userRow.password_hash))) {
      res.status(401).json({ error: "Invalid username or password." });
      return;
    }

    const user = { id: userRow.id, username: userRow.username };
    res.json({ token: signAuthToken(user), user });
  } catch (error) {
    console.error("login failed", error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/me", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

const generateInviteToken = () => randomBytes(24).toString("base64url");

const normalizeAccessCode = (value?: string) => value?.trim() ?? "";

const toRoomAccess = (row: RoomAccessRow): RoomAccess => ({
  roomId: row.room_id,
  displayName: row.display_name,
  inviteToken: row.invite_token,
  createdAt: row.created_at
});

const requireDatabase = (res: express.Response) => {
  if (databasePool && persistenceAvailable) {
    return databasePool;
  }

  res.status(503).json({ error: `Database is unavailable: ${persistenceUnavailableReason}` });
  return null;
};

const createRoomAccess = async (displayName?: string) => {
  if (!databasePool || !persistenceAvailable) {
    throw new Error(`Database is unavailable: ${persistenceUnavailableReason}`);
  }

  const roomId = randomUUID();
  const inviteToken = generateInviteToken();
  const roomDisplayName = displayName?.trim() || "Untitled room";
  const result = await databasePool.query<RoomAccessRow>(
    `
      insert into room_access (room_id, display_name, invite_token)
      values ($1, $2, $3)
      returning room_id, display_name, invite_token, created_at
    `,
    [roomId, roomDisplayName, inviteToken]
  );

  return toRoomAccess(result.rows[0]);
};

const saveUserRoom = async (userId: number, access: RoomAccess) => {
  if (!databasePool || !persistenceAvailable) {
    throw new Error(`Database is unavailable: ${persistenceUnavailableReason}`);
  }

  const result = await databasePool.query<UserRoomRow>(
    `
      insert into user_rooms (user_id, room_id, display_name, invite_token, last_opened)
      values ($1, $2, $3, $4, now())
      on conflict (user_id, room_id) do update set
        display_name = excluded.display_name,
        invite_token = excluded.invite_token,
        last_opened = now()
      returning id, user_id, room_id, display_name, invite_token, last_opened
    `,
    [userId, access.roomId, access.displayName, access.inviteToken]
  );

  return result.rows[0];
};

const resolveRoomAccess = async (accessCode?: string) => {
  if (!databasePool || !persistenceAvailable) {
    return null;
  }

  const normalizedAccessCode = normalizeAccessCode(accessCode);
  if (!normalizedAccessCode) {
    return null;
  }

  const result = await databasePool.query<RoomAccessRow>(
    `
      select room_id, display_name, invite_token, created_at
      from room_access
      where room_id = $1 or invite_token = $1
      limit 1
    `,
    [normalizedAccessCode]
  );

  return result.rows[0] ? toRoomAccess(result.rows[0]) : null;
};

app.get("/rooms/recent", requireAuth, async (req: AuthenticatedRequest, res) => {
  const pool = requireDatabase(res);
  if (!pool || !req.user) {
    return;
  }

  try {
    const result = await pool.query<UserRoomRow>(
      `
        select id, user_id, room_id, display_name, invite_token, last_opened
        from user_rooms
        where user_id = $1
        order by last_opened desc
        limit 10
      `,
      [req.user.id]
    );
    res.json({
      rooms: result.rows.map((room) => ({
        roomId: room.room_id,
        displayName: room.display_name,
        inviteToken: room.invite_token,
        lastOpened: room.last_opened.toISOString()
      }))
    });
  } catch (error) {
    console.error("recent rooms failed", error);
    res.status(500).json({ error: "Could not load recent rooms." });
  }
});

app.delete("/rooms/recent", requireAuth, async (req: AuthenticatedRequest, res) => {
  const pool = requireDatabase(res);
  if (!pool || !req.user) {
    return;
  }

  await pool.query("delete from user_rooms where user_id = $1", [req.user.id]);
  res.json({ success: true });
});

app.delete("/rooms/recent/:roomId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const pool = requireDatabase(res);
  if (!pool || !req.user) {
    return;
  }

  await pool.query("delete from user_rooms where user_id = $1 and room_id = $2", [
    req.user.id,
    req.params.roomId
  ]);
  res.json({ success: true });
});

app.post("/rooms/create", requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!requireDatabase(res)) {
    return;
  }

  try {
    const { displayName } = req.body as CreateRoomPayload;
    const access = await createRoomAccess(displayName);
    const room = createRoomState();
    rooms.set(access.roomId, room);
    await saveWorkspaceSnapshot(access.roomId, room);
    if (req.user) {
      await saveUserRoom(req.user.id, access);
    }

    res.status(201).json({
      roomId: access.roomId,
      displayName: access.displayName,
      inviteToken: access.inviteToken,
      inviteLink: `${FRONTEND_URL}/?invite=${encodeURIComponent(access.inviteToken)}`,
      createdAt: access.createdAt.toISOString()
    });
  } catch (error) {
    console.error("room create failed", error);
    res.status(500).json({ error: "Could not create room." });
  }
});

app.post("/rooms/join", requireAuth, async (req: AuthenticatedRequest, res) => {
  const { accessCode } = req.body as ResolveRoomPayload;
  const access = await resolveRoomAccess(accessCode);
  if (!access) {
    res.status(404).json({ error: "Room not found or access denied." });
    return;
  }

  if (req.user) {
    await saveUserRoom(req.user.id, access);
  }

  res.json({
    roomId: access.roomId,
    displayName: access.displayName,
    inviteToken: access.inviteToken,
    inviteLink: `${FRONTEND_URL}/?invite=${encodeURIComponent(access.inviteToken)}`
  });
});

app.post("/rooms", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { displayName } = req.body as CreateRoomPayload;
    const access = await createRoomAccess(displayName);
    const room = createRoomState();
    rooms.set(access.roomId, room);
    await saveWorkspaceSnapshot(access.roomId, room);
    if (req.user) {
      await saveUserRoom(req.user.id, access);
    }

    res.status(201).json({
      roomId: access.roomId,
      displayName: access.displayName,
      inviteToken: access.inviteToken,
      inviteLink: `${FRONTEND_URL}/?invite=${encodeURIComponent(access.inviteToken)}`,
      createdAt: access.createdAt.toISOString()
    });
  } catch (error) {
    console.error("room create failed", error);
    res.status(500).json({ error: "Could not create room." });
  }
});

app.post("/rooms/resolve", requireAuth, async (req: AuthenticatedRequest, res) => {
  const { accessCode } = req.body as ResolveRoomPayload;
  const access = await resolveRoomAccess(accessCode);
  if (!access) {
    res.status(404).json({ error: "Room not found or access denied." });
    return;
  }

  if (req.user) {
    await saveUserRoom(req.user.id, access);
  }

  res.json({
    roomId: access.roomId,
    displayName: access.displayName,
    inviteToken: access.inviteToken,
    inviteLink: `${FRONTEND_URL}/?invite=${encodeURIComponent(access.inviteToken)}`
  });
});

app.post("/execute", async (req, res) => {
  const authUser = verifyAuthToken(getBearerToken(req));
  if (!authUser) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const { roomId, fileName, username, language, code } = req.body as Partial<ExecuteCodePayload>;
  const roomFile = roomId && fileName ? rooms.get(roomId)?.files.get(fileName) : null;
  const executionLanguage = roomFile?.language ?? (fileName ? inferLanguageFromFileName(fileName) : language);

  if (!executionLanguage || !judge0LanguageIds[executionLanguage]) {
    res.status(400).json({ error: "Unsupported language." });
    return;
  }

  if (typeof code !== "string") {
    res.status(400).json({ error: "Code must be a string." });
    return;
  }

  try {
    console.log(`Executing code with Judge0: language=${executionLanguage}`);

    const room = roomId ? rooms.get(roomId) ?? null : null;
    if (roomId && room) {
      room.execution = {
        output: "",
        error: "",
        status: "Running...",
        roomId,
        fileName,
        username
      };
      console.log(`execution-start: room=${roomId}, file=${fileName || "active"}, username=${username || "Unknown"}`);
      io.to(roomId).emit("execution-start", room.execution);
    }

  const judge0Response = await fetch(
      `${JUDGE0_API_URL}/submissions?base64_encoded=false&wait=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          source_code: code,
          language_id: judge0LanguageIds[executionLanguage]
        })
      }
    );

    if (!judge0Response.ok) {
      const errorText = await judge0Response.text();
      console.error(`Judge0 request failed: ${judge0Response.status} ${errorText}`);
      if (roomId && room) {
        room.execution = {
          output: "",
          error: "Code execution service failed.",
          status: "Error",
          roomId,
          fileName,
          username
        };
        console.log(`execution-result: room=${roomId}, file=${fileName || "active"}, username=${username || "Unknown"}, status=Error`);
        io.to(roomId).emit("execution-result", room.execution);
      }
      res.status(502).json({ error: "Code execution service failed." });
      return;
    }

    const result = (await judge0Response.json()) as Judge0Response;
    const output = result.stdout || "";
    const error = result.stderr || result.compile_output || result.message || "";
    const execution = {
      output: output || "No output.",
      error,
      status: result.status?.description ?? "Unknown",
      time: result.time,
      memory: result.memory
    };

    console.log(
      `Execution finished: language=${executionLanguage}, status=${result.status?.description ?? "Unknown"}`
    );

    if (roomId && room) {
      room.execution = {
        output: execution.output,
        error: execution.error,
        status: execution.status,
        roomId,
        fileName,
        username
      };
      console.log(
        `execution-result: room=${roomId}, file=${fileName || "active"}, username=${username || "Unknown"}, status=${execution.status}`
      );
      io.to(roomId).emit("execution-result", room.execution);
    }

    res.json(execution);
  } catch (error) {
    console.error("Execution error:", error);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.execution = {
          output: "",
          error: "Unable to execute code right now.",
          status: "Error",
          roomId,
          fileName,
          username
        };
        console.log(`execution-result: room=${roomId}, file=${fileName || "active"}, username=${username || "Unknown"}, status=Error`);
        io.to(roomId).emit("execution-result", room.execution);
      }
    }
    res.status(500).json({ error: "Unable to execute code right now." });
  }
});

const emitActiveUsers = (roomId: string) => {
  const users = Array.from(rooms.get(roomId)?.users.values() ?? []);
  io.to(roomId).emit("active-users", users);
};

const emitCursorPositions = (roomId: string) => {
  const cursors = Array.from(rooms.get(roomId)?.cursorPositions.values() ?? []);
  io.to(roomId).emit("cursor-positions", cursors);
};

const serializeFiles = (room: RoomState) => Array.from(room.files.values());

const serializeProject = (room: RoomState) => ({
  files: serializeFiles(room),
  projectTree: room.projectTree,
  activeFileName: room.activeFileName
});

const getRoomFile = (room: RoomState, fileName: string) => room.files.get(fileName);

const cloneProjectTree = (nodes: ProjectTreeNode[]): ProjectTreeNode[] =>
  nodes.map((node) => ({
    ...node,
    children: node.children ? cloneProjectTree(node.children) : undefined
  }));

const inferLanguageFromFileName = (fileName: string): SupportedLanguage => {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".tsx")) return "typescript";
  if (lowerName.endsWith(".ts")) return "typescript";
  if (lowerName.endsWith(".js")) return "javascript";
  if (lowerName.endsWith(".py")) return "python";
  if (lowerName.endsWith(".java")) return "java";
  if (lowerName.endsWith(".cpp")) return "cpp";
  if (lowerName.endsWith(".html")) return "html";
  if (lowerName.endsWith(".css")) return "css";
  if (lowerName.endsWith(".json")) return "json";
  return "plaintext";
};

const syncFileLanguageWithExtension = <T extends { fileName: string; language: SupportedLanguage }>(
  file: T
): T => ({
  ...file,
  language: inferLanguageFromFileName(file.fileName)
});

const normalizeProjectPath = (value?: string) =>
  (value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");

const isValidNodeName = (name: string) => {
  const trimmedName = name.trim();
  return Boolean(trimmedName) && !trimmedName.includes("/") && !trimmedName.includes("\\");
};

const joinProjectPath = (parentPath: string, name: string) =>
  normalizeProjectPath(parentPath ? `${parentPath}/${name}` : name);

const findProjectNode = (
  nodes: ProjectTreeNode[],
  targetPath: string
): { node: ProjectTreeNode; siblings: ProjectTreeNode[]; index: number } | null => {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.path === targetPath) {
      return { node, siblings: nodes, index };
    }

    if (node.children) {
      const result = findProjectNode(node.children, targetPath);
      if (result) {
        return result;
      }
    }
  }

  return null;
};

const sortProjectNodes = (nodes: ProjectTreeNode[]) => {
  nodes.sort((first, second) => {
    if (first.type !== second.type) {
      return first.type === "folder" ? -1 : 1;
    }

    return first.name.localeCompare(second.name);
  });

  nodes.forEach((node) => {
    if (node.children) {
      sortProjectNodes(node.children);
    }
  });
};

const buildProjectTreeFromFiles = (files: WorkspaceFile[]) => {
  const rootNodes: ProjectTreeNode[] = [];

  files.forEach((file) => {
    const pathParts = normalizeProjectPath(file.fileName).split("/");
    let siblings = rootNodes;
    let currentPath = "";

    pathParts.forEach((part, index) => {
      currentPath = joinProjectPath(currentPath, part);
      const isFile = index === pathParts.length - 1;
      let node = siblings.find((candidate) => candidate.path === currentPath);

      if (!node) {
        node = {
          id: currentPath,
          type: isFile ? "file" : "folder",
          name: part,
          path: currentPath,
          children: isFile ? undefined : []
        };
        siblings.push(node);
      }

      if (!isFile) {
        node.children ??= [];
        siblings = node.children;
      }
    });
  });

  sortProjectNodes(rootNodes);
  return rootNodes;
};

const collectFilePaths = (nodes: ProjectTreeNode[]) => {
  const filePaths: string[] = [];

  const visit = (node: ProjectTreeNode) => {
    if (node.type === "file") {
      filePaths.push(node.path);
      return;
    }

    node.children?.forEach(visit);
  };

  nodes.forEach(visit);
  return filePaths;
};

const createRoomState = (
  files: WorkspaceFile[] = defaultWorkspaceFiles,
  activeFileName = files[0]?.fileName ?? defaultWorkspaceFiles[0].fileName,
  projectTree: ProjectTreeNode[] = files === defaultWorkspaceFiles
    ? defaultProjectTree
    : buildProjectTreeFromFiles(files)
): RoomState => {
  const syncedFiles = files.map(syncFileLanguageWithExtension);

  return {
    users: new Map<string, RoomUser>(),
    typingUsers: new Set<string>(),
    cursorPositions: new Map<string, CursorPosition>(),
    execution: {
      output: "Run code to see output here.",
      error: "",
      status: ""
    },
    activeFileName,
    projectTree: cloneProjectTree(projectTree),
    files: new Map(
      syncedFiles.map((file) => [
        file.fileName,
        {
          ...file,
          operationHistory: []
        }
      ])
    )
  };
};

const toPersistedFiles = (files: WorkspaceFile[]) => {
  const updatedAt = new Date();
  return files.map(({ fileName, code, version }) => ({
    fileName,
    code,
    language: inferLanguageFromFileName(fileName),
    version,
    updatedAt
  }));
};

const toWorkspaceFiles = (files: PersistedWorkspaceFile[]): WorkspaceFile[] =>
  files.map(({ fileName, code, version }) => ({
    fileName,
    code,
    language: inferLanguageFromFileName(fileName),
    version,
    operationHistory: []
  }));

const getSafeDatabaseUrl = () => {
  if (!DATABASE_URL) {
    return "missing";
  }

  try {
    const url = new URL(DATABASE_URL);
    if (url.password) {
      url.password = "****";
    }
    return url.toString();
  } catch {
    return "configured";
  }
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const emitAutosaveStatus = (roomId: string, status: AutosaveState, error?: unknown, savedAt?: Date) => {
  io.to(roomId).emit("autosave-status", {
    roomId,
    status,
    error: error instanceof Error ? error.message : undefined,
    savedAt: savedAt?.toISOString()
  });
};

const connectDatabase = async () => {
  logInfo(`DATABASE_URL found: ${DATABASE_URL ? "yes" : "no"}`);

  if (!DATABASE_URL) {
    persistenceAvailable = false;
    persistenceUnavailableReason = "DATABASE_URL missing in server/.env";
    databasePool = null;
    console.error("DATABASE_URL missing");
    return;
  }

  logInfo("PostgreSQL connecting...");

  let pool: Pool | null = null;

  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 5000,
      idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS) || 30000,
      max: Number(process.env.DATABASE_POOL_MAX) || 10,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });

    pool.on("error", (error) => {
      persistenceAvailable = false;
      persistenceUnavailableReason = getErrorMessage(error);
      console.error(`PostgreSQL pool error: ${persistenceUnavailableReason}`);
      scheduleDatabaseReconnect();
    });

    const nowResult = await pool.query<{ now: Date }>("select now()");
    logInfo(`PostgreSQL SELECT NOW() succeeded: ${nowResult.rows[0]?.now ?? "ok"}`);

    await pool.query(`
      create table if not exists workspaces (
        room_id text primary key,
        files jsonb not null,
        project_tree jsonb not null default '[]'::jsonb,
        active_file_name text not null,
        active_file jsonb,
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query("alter table workspaces add column if not exists project_tree jsonb not null default '[]'::jsonb");
    logInfo("PostgreSQL workspaces table ready");

    await pool.query(`
      create table if not exists room_access (
        room_id text primary key,
        display_name text not null,
        invite_token text not null unique,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query("create index if not exists room_access_invite_token_idx on room_access (invite_token)");
    logInfo("PostgreSQL room_access table ready");

    await pool.query(`
      create table if not exists users (
        id serial primary key,
        username text unique not null,
        password_hash text not null,
        created_at timestamp default current_timestamp
      )
    `);
    await pool.query(`
      create table if not exists user_rooms (
        id serial primary key,
        user_id integer references users(id) on delete cascade,
        room_id text not null,
        display_name text not null,
        invite_token text not null,
        last_opened timestamp default current_timestamp,
        unique(user_id, room_id)
      )
    `);
    await pool.query("create index if not exists user_rooms_user_last_opened_idx on user_rooms (user_id, last_opened desc)");
    logInfo("PostgreSQL users and user_rooms tables ready");

    databasePool = pool;
    persistenceAvailable = true;
    persistenceUnavailableReason = "";
    logInfo(`PostgreSQL connected successfully: url=${getSafeDatabaseUrl()}`);
  } catch (error) {
    if (pool) {
      await pool.end().catch(() => undefined);
    }

    databasePool = null;
    persistenceAvailable = false;
    persistenceUnavailableReason = getErrorMessage(error);
    console.error(`PostgreSQL connection failed: ${persistenceUnavailableReason}`);
    scheduleDatabaseReconnect();
  }
};

const scheduleDatabaseReconnect = () => {
  if (databaseReconnectTimer || !DATABASE_URL) {
    return;
  }

  databaseReconnectTimer = setTimeout(() => {
    databaseReconnectTimer = null;
    void connectDatabase();
  }, Number(process.env.DATABASE_RECONNECT_MS) || 5000);
};

const initializeRedisAdapter = async () => {
  logInfo(`Redis connecting: url=${REDIS_URL}`);

  const pubClient = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
    }
  });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (error) => {
    console.error(`Redis pub client error: ${getErrorMessage(error)}`);
  });

  subClient.on("error", (error) => {
    console.error(`Redis sub client error: ${getErrorMessage(error)}`);
  });

  pubClient.on("reconnecting", () => logInfo("Redis pub client reconnecting"));
  subClient.on("reconnecting", () => logInfo("Redis sub client reconnecting"));

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    logInfo("Redis connected");
    io.adapter(createAdapter(pubClient, subClient));
    redisPubClient = pubClient as RedisClientType;
    redisSubClient = subClient as RedisClientType;
    logInfo("Redis adapter initialized");
  } catch (error) {
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    redisPubClient = null;
    redisSubClient = null;
    console.error(`Redis unavailable, Socket.IO scaling disabled: ${getErrorMessage(error)}`);
  }
};

const loadWorkspace = async (roomId: string): Promise<LoadedWorkspace | null> => {
  console.log(`loading workspace for roomId=${roomId}`);

  if (!databasePool || !persistenceAvailable) {
    console.log(
      `no workspace found, creating default workspace: roomId=${roomId}, reason=${persistenceUnavailableReason}`
    );
    return null;
  }

  try {
    const workspaceResult = await databasePool.query<PersistedWorkspaceRow>(
      `
        select room_id, files, project_tree, active_file_name, active_file, updated_at
        from workspaces
        where room_id = $1
      `,
      [roomId]
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace) {
      console.log(`no workspace found, creating default workspace: roomId=${roomId}`);
      return null;
    }

    const files = toWorkspaceFiles(workspace.files);
    const activeFileName =
      files.some((file) => file.fileName === workspace.active_file_name)
        ? workspace.active_file_name
        : files[0]?.fileName ?? defaultWorkspaceFiles[0].fileName;

    const projectTree =
      workspace.project_tree && workspace.project_tree.length > 0
        ? workspace.project_tree
        : buildProjectTreeFromFiles(files);

    console.log(`existing workspace found: roomId=${roomId}, files=${workspace.files.length}, activeFile=${activeFileName}`);
    return { files, projectTree, activeFileName };
  } catch (error) {
    console.error(`autosave failed with error: workspace load failed for roomId=${roomId}`, error);
    console.log(`no workspace found, creating default workspace: roomId=${roomId}, reason=load failed`);
    return null;
  }
};

const saveWorkspaceSnapshot = async (roomId: string, room: RoomState) => {
  if (!databasePool || !persistenceAvailable) {
    const error = new Error(`Database is unavailable: ${persistenceUnavailableReason}`);
    console.error(`autosave failed with error: roomId=${roomId}`, error);
    emitAutosaveStatus(roomId, "failed", error);
    return null;
  }

  const files = serializeFiles(room);
  const persistedFiles = toPersistedFiles(files);
  const activeFile =
    persistedFiles.find((file) => file.fileName === room.activeFileName) ?? persistedFiles[0] ?? null;
  const updatedAt = new Date();

  try {
    await databasePool.query(
      `
        insert into workspaces (room_id, files, project_tree, active_file_name, active_file, updated_at)
        values ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6)
        on conflict (room_id) do update set
          files = excluded.files,
          project_tree = excluded.project_tree,
          active_file_name = excluded.active_file_name,
          active_file = excluded.active_file,
          updated_at = excluded.updated_at
      `,
      [
        roomId,
        JSON.stringify(persistedFiles),
        JSON.stringify(room.projectTree),
        activeFile?.fileName ?? room.activeFileName,
        JSON.stringify(activeFile),
        updatedAt
      ]
    );
    console.log(
      `workspace saved successfully: roomId=${roomId}, files=${persistedFiles.length}, activeFile=${activeFile?.fileName ?? "none"}`
    );
    emitAutosaveStatus(roomId, "saved", undefined, updatedAt);
    return updatedAt;
  } catch (error) {
    console.error(`autosave failed with error: roomId=${roomId}`, error);
    emitAutosaveStatus(roomId, "failed", error);
    return null;
  }
};

const clearPendingWorkspaceSave = (roomId: string) => {
  const existingTimer = autosaveTimers.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    autosaveTimers.delete(roomId);
  }
};

const scheduleWorkspaceSave = (roomId: string, room: RoomState) => {
  clearPendingWorkspaceSave(roomId);

  const timer = setTimeout(() => {
    autosaveTimers.delete(roomId);
    void saveWorkspaceSnapshot(roomId, room);
  }, autosaveDebounceMs);

  autosaveTimers.set(roomId, timer);
  console.log(`autosave scheduled: roomId=${roomId}, delayMs=${autosaveDebounceMs}`);
  emitAutosaveStatus(roomId, "saving");
};

const flushWorkspaceSave = (roomId: string, room: RoomState) => {
  clearPendingWorkspaceSave(roomId);

  void saveWorkspaceSnapshot(roomId, room);
};

const emitProjectUpdate = (roomId: string, room: RoomState, syncStatus: SyncStatus = "Applied") => {
  io.to(roomId).emit("project-update", {
    ...serializeProject(room),
    syncStatus
  });
};

const addProjectNode = (room: RoomState, payload: ProjectCreatePayload) => {
  const name = payload.name.trim();
  const parentPath = normalizeProjectPath(
    payload.parentFolderPath ?? payload.selectedFolderPath ?? payload.parentPath
  );

  if (!isValidNodeName(name)) {
    return null;
  }

  const parent = parentPath ? findProjectNode(room.projectTree, parentPath)?.node : null;
  if (parentPath && (!parent || parent.type !== "folder")) {
    return null;
  }

  const siblings = parent ? (parent.children ??= []) : room.projectTree;
  const nextPath = joinProjectPath(parentPath, name);
  if (siblings.some((node) => node.name === name) || findProjectNode(room.projectTree, nextPath)) {
    return null;
  }

  const node: ProjectTreeNode = {
    id: nextPath,
    type: payload.type,
    name,
    path: nextPath,
    children: payload.type === "folder" ? [] : undefined
  };

  siblings.push(node);
  sortProjectNodes(siblings);

  if (payload.type === "file") {
    const language = inferLanguageFromFileName(name);
    room.files.set(nextPath, {
      fileName: nextPath,
      language,
      code: starterCodeByLanguage[language],
      version: 1,
      operationHistory: []
    });
    room.activeFileName = nextPath;
  }

  return node;
};

const rewriteProjectNodePath = (node: ProjectTreeNode, oldPrefix: string, newPrefix: string) => {
  const suffix = node.path.slice(oldPrefix.length).replace(/^\//, "");
  node.path = suffix ? `${newPrefix}/${suffix}` : newPrefix;
  node.id = node.path;

  if (node.children) {
    node.children.forEach((child) => rewriteProjectNodePath(child, oldPrefix, newPrefix));
  }
};

const renameProjectNode = (room: RoomState, payload: ProjectRenamePayload) => {
  const targetPath = normalizeProjectPath(payload.path);
  const name = payload.name.trim();

  if (!targetPath || !isValidNodeName(name)) {
    return false;
  }

  const result = findProjectNode(room.projectTree, targetPath);
  if (!result) {
    return false;
  }

  if (result.siblings.some((node) => node.path !== targetPath && node.name === name)) {
    return false;
  }

  const parentPath = targetPath.includes("/") ? targetPath.split("/").slice(0, -1).join("/") : "";
  const nextPath = joinProjectPath(parentPath, name);
  const oldPath = result.node.path;
  result.node.name = name;
  rewriteProjectNodePath(result.node, oldPath, nextPath);
  sortProjectNodes(result.siblings);

  if (result.node.type === "file") {
    const file = room.files.get(oldPath);
    if (file) {
      room.files.delete(oldPath);
      file.fileName = nextPath;
      file.language = inferLanguageFromFileName(name);
      file.version += 1;
      file.operationHistory = [];
      room.files.set(nextPath, file);
    }
  } else {
    const renamedFiles = new Map<string, WorkspaceFile>();
    room.files.forEach((file, filePath) => {
      if (filePath === oldPath || filePath.startsWith(`${oldPath}/`)) {
        const suffix = filePath.slice(oldPath.length).replace(/^\//, "");
        const nextFilePath = suffix ? `${nextPath}/${suffix}` : nextPath;
        file.fileName = nextFilePath;
        file.operationHistory = [];
        renamedFiles.set(nextFilePath, file);
      } else {
        renamedFiles.set(filePath, file);
      }
    });
    room.files = renamedFiles;
  }

  if (room.activeFileName === oldPath || room.activeFileName.startsWith(`${oldPath}/`)) {
    const suffix = room.activeFileName.slice(oldPath.length).replace(/^\//, "");
    room.activeFileName = suffix ? `${nextPath}/${suffix}` : nextPath;
  }

  room.cursorPositions.forEach((cursor) => {
    if (cursor.fileName === oldPath || cursor.fileName.startsWith(`${oldPath}/`)) {
      const suffix = cursor.fileName.slice(oldPath.length).replace(/^\//, "");
      cursor.fileName = suffix ? `${nextPath}/${suffix}` : nextPath;
    }
  });

  return true;
};

const deleteProjectNode = (room: RoomState, targetPath: string) => {
  const normalizedPath = normalizeProjectPath(targetPath);
  const result = findProjectNode(room.projectTree, normalizedPath);
  if (!result) {
    return false;
  }

  const removedNode = result.node;
  result.siblings.splice(result.index, 1);

  if (removedNode.type === "file") {
    room.files.delete(removedNode.path);
  } else {
    collectFilePaths([removedNode]).forEach((filePath) => room.files.delete(filePath));
  }

  room.cursorPositions.forEach((cursor, socketId) => {
    if (cursor.fileName === normalizedPath || cursor.fileName.startsWith(`${normalizedPath}/`)) {
      room.cursorPositions.delete(socketId);
    }
  });

  if (!room.files.has(room.activeFileName)) {
    room.activeFileName = Array.from(room.files.keys())[0] ?? "";
  }

  return true;
};

const sanitizeUploadedTree = (nodes: ProjectTreeNode[]): ProjectTreeNode[] => {
  const sanitizeNode = (node: ProjectTreeNode): ProjectTreeNode | null => {
    const nodePath = normalizeProjectPath(node.path);
    const name = node.name.trim();
    if (!nodePath || !isValidNodeName(name) || (node.type !== "file" && node.type !== "folder")) {
      return null;
    }

    return {
      id: nodePath,
      type: node.type,
      name,
      path: nodePath,
      children: node.type === "folder" ? (node.children ?? []).map(sanitizeNode).filter((child): child is ProjectTreeNode => Boolean(child)) : undefined
    };
  };

  const sanitized = nodes.map(sanitizeNode).filter((node): node is ProjectTreeNode => Boolean(node));
  sortProjectNodes(sanitized);
  return sanitized;
};

const replaceRoomWithUploadedProject = (room: RoomState, payload: ProjectUploadPayload) => {
  if (!Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > maxUploadedFiles) {
    return false;
  }

  const nextFiles = new Map<string, WorkspaceFile>();

  for (const uploadedFile of payload.files) {
    const fileName = normalizeProjectPath(uploadedFile.fileName);
    if (!fileName || nextFiles.has(fileName) || typeof uploadedFile.code !== "string") {
      return false;
    }

    if (Buffer.byteLength(uploadedFile.code, "utf8") > maxUploadedFileBytes) {
      return false;
    }

    const language = inferLanguageFromFileName(fileName);
    nextFiles.set(fileName, {
      fileName,
      language,
      code: uploadedFile.code,
      version: 1,
      operationHistory: []
    });
  }

  const sanitizedTree = sanitizeUploadedTree(payload.projectTree);
  const projectTree = sanitizedTree.length > 0 ? sanitizedTree : buildProjectTreeFromFiles(Array.from(nextFiles.values()));
  const activeFileName = Array.from(nextFiles.keys())[0] ?? "";

  room.files = nextFiles;
  room.projectTree = projectTree;
  room.activeFileName = activeFileName;
  room.cursorPositions.clear();
  room.typingUsers.clear();
  room.execution = {
    output: "Run code to see output here.",
    error: "",
    status: ""
  };

  return true;
};

const normalizeIncomingOperation = (payload: CodeChangePayload): TextOperation | null => {
  if (!payload.roomId || !payload.fileName || !Number.isInteger(payload.baseVersion)) {
    return null;
  }

  if (!Number.isInteger(payload.position) || payload.position < 0) {
    return null;
  }

  if (payload.type === "insert") {
    if (typeof payload.text !== "string" || payload.text.length === 0) {
      return null;
    }

    return {
      roomId: payload.roomId,
      fileName: payload.fileName,
      username: payload.username,
      baseVersion: payload.baseVersion,
      appliedVersion: 0,
      type: "insert",
      position: payload.position,
      text: payload.text,
      length: payload.text.length
    };
  }

  if (payload.type === "delete") {
    if (!Number.isInteger(payload.length) || (payload.length ?? 0) <= 0) {
      return null;
    }

    return {
      roomId: payload.roomId,
      fileName: payload.fileName,
      username: payload.username,
      baseVersion: payload.baseVersion,
      appliedVersion: 0,
      type: "delete",
      position: payload.position,
      text: "",
      length: payload.length ?? 0
    };
  }

  return null;
};

const isOperationValidForDocument = (operation: TextOperation, code: string) => {
  if (operation.position < 0 || operation.position > code.length) {
    return false;
  }

  if (operation.type === "insert") {
    return operation.text.length > 0;
  }

  return operation.length > 0 && operation.position + operation.length <= code.length;
};

const applyOperation = (code: string, operation: TextOperation) => {
  if (operation.type === "insert") {
    return code.slice(0, operation.position) + operation.text + code.slice(operation.position);
  }

  return code.slice(0, operation.position) + code.slice(operation.position + operation.length);
};

const cloneOperation = (operation: TextOperation): TextOperation => ({ ...operation });

const transformAgainstAppliedOperation = (
  incoming: TextOperation,
  applied: TextOperation
): TextOperation | null => {
  const transformed = cloneOperation(incoming);

  // Insert vs insert: if someone inserted before us, move our insert to the right.
  // For same-position inserts, the already-applied operation wins ordering.
  if (transformed.type === "insert" && applied.type === "insert") {
    if (applied.position <= transformed.position) {
      transformed.position += applied.text.length;
    }
    return transformed;
  }

  // Insert vs delete: if text was deleted before our insert point, move left.
  // If our insert point was inside the deleted range, anchor it at the deletion start.
  if (transformed.type === "insert" && applied.type === "delete") {
    const appliedEnd = applied.position + applied.length;
    if (appliedEnd <= transformed.position) {
      transformed.position -= applied.length;
    } else if (applied.position < transformed.position) {
      transformed.position = applied.position;
    }
    return transformed;
  }

  // Delete vs insert: inserts before or inside our delete range shift/expand the range.
  if (transformed.type === "delete" && applied.type === "insert") {
    if (applied.position <= transformed.position) {
      transformed.position += applied.text.length;
    } else if (applied.position < transformed.position + transformed.length) {
      transformed.length += applied.text.length;
    }
    return transformed;
  }

  // Delete vs delete: shrink or shift our range around text that is already gone.
  if (transformed.type === "delete" && applied.type === "delete") {
    const transformedEnd = transformed.position + transformed.length;
    const appliedEnd = applied.position + applied.length;

    if (appliedEnd <= transformed.position) {
      transformed.position -= applied.length;
      return transformed;
    }

    if (applied.position >= transformedEnd) {
      return transformed;
    }

    const overlapStart = Math.max(transformed.position, applied.position);
    const overlapEnd = Math.min(transformedEnd, appliedEnd);
    transformed.length -= overlapEnd - overlapStart;

    if (applied.position < transformed.position) {
      transformed.position = applied.position;
    }

    return transformed.length > 0 ? transformed : null;
  }

  return transformed;
};

const transformOperation = (operation: TextOperation, history: TextOperation[]) => {
  let transformed: TextOperation | null = cloneOperation(operation);

  for (const appliedOperation of history) {
    if (!transformed) {
      return null;
    }
    transformed = transformAgainstAppliedOperation(transformed, appliedOperation);
  }

  return transformed;
};

const storeOperation = (file: WorkspaceFile, operation: TextOperation) => {
  file.operationHistory.push(operation);
  if (file.operationHistory.length > maxOperationHistory) {
    file.operationHistory.splice(0, file.operationHistory.length - maxOperationHistory);
  }
};

const getOrCreateRoom = (roomId: string) => {
  let room = rooms.get(roomId);

  if (!room) {
    room = createRoomState();
    rooms.set(roomId, room);
  }

  return room;
};

const getJoinedRoom = (socket: Socket, roomId: string) => {
  if (!roomId || !socket.rooms.has(roomId)) {
    socket.emit("room-access-denied", { message: "Room not found or access denied." });
    return null;
  }

  const room = rooms.get(roomId);
  if (!room) {
    socket.emit("room-access-denied", { message: "Room is not active." });
    return null;
  }

  return room;
};

const getOrLoadRoom = async (roomId: string) => {
  const activeRoom = rooms.get(roomId);
  if (activeRoom) {
    console.log(`loading workspace for roomId=${roomId}, source=memory`);
    console.log(`existing workspace found: roomId=${roomId}, source=memory, files=${activeRoom.files.size}`);
    return activeRoom;
  }

  const pendingLoad = roomLoadPromises.get(roomId);
  if (pendingLoad) {
    return pendingLoad;
  }

  const loadPromise = (async () => {
    const persistedWorkspace = await loadWorkspace(roomId);
    const room = createRoomState(
      persistedWorkspace?.files ?? defaultWorkspaceFiles,
      persistedWorkspace?.activeFileName ?? defaultWorkspaceFiles[0].fileName,
      persistedWorkspace?.projectTree ?? defaultProjectTree
    );
    rooms.set(roomId, room);

    const hadLanguageMismatch =
      persistedWorkspace?.files.some((file) => file.language !== inferLanguageFromFileName(file.fileName)) ?? false;

    if (!persistedWorkspace || hadLanguageMismatch) {
      scheduleWorkspaceSave(roomId, room);
    }

    return room;
  })();

  roomLoadPromises.set(roomId, loadPromise);

  try {
    return await loadPromise;
  } finally {
    roomLoadPromises.delete(roomId);
  }
};

const getTypingUsers = (room: RoomState) =>
  Array.from(room.typingUsers)
    .map((socketId) => room.users.get(socketId))
    .filter((user): user is RoomUser => Boolean(user));

const createTypingPayload = (roomId: string, room: RoomState, socketId: string) => {
  const user = room.users.get(socketId);

  return {
    roomId,
    socketId,
    username: user?.username || "Anonymous",
    typingUsers: getTypingUsers(room)
  };
};

const removeSocketFromRooms = (socket: Socket) => {
  rooms.forEach((room, roomId) => {
    if (!room.users.has(socket.id)) {
      return;
    }

    room.users.delete(socket.id);
    room.typingUsers.delete(socket.id);
    room.cursorPositions.delete(socket.id);
    if (room.users.size === 0) {
      flushWorkspaceSave(roomId, room);
      rooms.delete(roomId);
      return;
    }

    const payload = createTypingPayload(roomId, room, socket.id);
    console.log(`typing-stop: room=${roomId}, username=${payload.username}`);
    io.to(roomId).emit("typing-stop", payload);
    emitActiveUsers(roomId);
    emitCursorPositions(roomId);
  });
};

io.use((socket, next) => {
  const token =
    typeof socket.handshake.auth?.token === "string"
      ? socket.handshake.auth.token
      : typeof socket.handshake.headers.authorization === "string" &&
          socket.handshake.headers.authorization.startsWith("Bearer ")
        ? socket.handshake.headers.authorization.slice("Bearer ".length).trim()
        : "";
  const user = verifyAuthToken(token);
  if (!user) {
    next(new Error("Authentication required."));
    return;
  }

  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join-room", async ({ roomId, inviteToken, username }: JoinRoomPayload) => {
    const authUser = socket.data.user as AuthUser | undefined;
    if (!authUser) {
      socket.emit("room-access-denied", { message: "Authentication required." });
      return;
    }

    const access = await resolveRoomAccess(inviteToken || roomId);
    if (!access) {
      socket.emit("room-access-denied", { message: "Room not found or access denied." });
      return;
    }

    await saveUserRoom(authUser.id, access);

    socket.join(access.roomId);

    const room = await getOrLoadRoom(access.roomId);
    const roomUsername = authUser.username || username || "Anonymous";
    room.users.set(socket.id, { socketId: socket.id, username: roomUsername });
    room.cursorPositions.set(socket.id, {
      socketId: socket.id,
      username: roomUsername,
      fileName: room.activeFileName,
      lineNumber: 1,
      column: 1
    });

    console.log(`Room joined: socket=${socket.id}, room=${access.roomId}, displayName=${access.displayName}`);
    socket.emit("room-joined", {
      roomId: access.roomId,
      displayName: access.displayName,
      inviteToken: access.inviteToken,
      inviteLink: `${FRONTEND_URL}/?invite=${encodeURIComponent(access.inviteToken)}`
    });
    socket.emit("sync-document", {
      files: serializeFiles(room),
      projectTree: room.projectTree,
      activeFileName: room.activeFileName,
      syncStatus: "Applied" satisfies SyncStatus,
      users: Array.from(room.users.values()),
      execution: room.execution
    });
    emitActiveUsers(access.roomId);
    emitCursorPositions(access.roomId);
  });

  socket.on("cursor-position", ({ roomId, fileName, username, lineNumber, column }: CursorPositionPayload) => {
    if (!roomId || !fileName || !Number.isInteger(lineNumber) || !Number.isInteger(column)) {
      return;
    }

    const room = getJoinedRoom(socket, roomId);
    if (!room) {
      return;
    }
    const storedUser = room.users.get(socket.id);
    const cursor = {
      socketId: socket.id,
      username: username || storedUser?.username || "Anonymous",
      fileName,
      lineNumber: Math.max(1, lineNumber),
      column: Math.max(1, column)
    };

    room.cursorPositions.set(socket.id, cursor);
    room.activeFileName = fileName;
    console.log(
      `cursor-position: socket=${socket.id}, room=${roomId}, file=${fileName}, line=${cursor.lineNumber}, column=${cursor.column}`
    );
    socket.to(roomId).emit("cursor-position", cursor);
    emitCursorPositions(roomId);
  });

  socket.on("code-change", (payload: CodeChangePayload) => {
    const operation = normalizeIncomingOperation(payload);

    if (!operation) {
      console.log(`invalid operation rejected: socket=${socket.id}`);
      return;
    }

    const { roomId, fileName, baseVersion } = operation;

    if (!roomId) {
      return;
    }

    const room = getJoinedRoom(socket, roomId);
    if (!room) {
      return;
    }
    const file = getRoomFile(room, fileName);

    if (!file) {
      console.log(`transform failed, fallback sync: socket=${socket.id}, room=${roomId}, file=${fileName}, reason=missing-file`);
      socket.emit("stale-document", {
        files: serializeFiles(room),
        projectTree: room.projectTree,
        activeFileName: room.activeFileName,
        syncStatus: "Fallback Resync" satisfies SyncStatus
      });
      return;
    }

    console.log(
      `operation received: socket=${socket.id}, room=${roomId}, file=${fileName}, type=${operation.type}, position=${operation.position}, baseVersion=${baseVersion}`
    );
    console.log(`received version: socket=${socket.id}, room=${roomId}, file=${fileName}, version=${baseVersion}`);
    console.log(`current room version: room=${roomId}, file=${fileName}, version=${file.version}`);

    const sendLatestDocument = () => {
      socket.emit("stale-document", {
        files: serializeFiles(room),
        projectTree: room.projectTree,
        activeFileName: fileName,
        syncStatus: "Fallback Resync" satisfies SyncStatus
      });
    };

    if (baseVersion > file.version) {
      console.log(
        `stale operation detected: socket=${socket.id}, room=${roomId}, file=${fileName}, clientVersion=${baseVersion}, serverVersion=${file.version}`
      );
      console.log(
        `stale update rejected: socket=${socket.id}, room=${roomId}, file=${fileName}, clientVersion=${baseVersion}, serverVersion=${file.version}`
      );
      console.log(`transform failed, fallback sync: socket=${socket.id}, room=${roomId}, file=${fileName}`);
      sendLatestDocument();
      return;
    }

    const operationsAfterBaseVersion = file.operationHistory.filter(
      (historyOperation) => historyOperation.appliedVersion > baseVersion
    );

    if (baseVersion < file.version && operationsAfterBaseVersion.length !== file.version - baseVersion) {
      console.log(
        `stale operation detected: socket=${socket.id}, room=${roomId}, file=${fileName}, clientVersion=${baseVersion}, serverVersion=${file.version}`
      );
      console.log(
        `stale update rejected: socket=${socket.id}, room=${roomId}, file=${fileName}, reason=missing-history, clientVersion=${baseVersion}, serverVersion=${file.version}`
      );
      console.log(`transform failed, fallback sync: socket=${socket.id}, room=${roomId}, file=${fileName}`);
      sendLatestDocument();
      return;
    }

    if (baseVersion < file.version) {
      console.log(
        `stale operation detected: socket=${socket.id}, room=${roomId}, file=${fileName}, clientVersion=${baseVersion}, serverVersion=${file.version}`
      );
    }

    const operationToApply =
      baseVersion === file.version
        ? operation
        : transformOperation(operation, operationsAfterBaseVersion);

    if (!operationToApply || !isOperationValidForDocument(operationToApply, file.code)) {
      console.log(
        `stale update rejected: socket=${socket.id}, room=${roomId}, file=${fileName}, reason=transform-failed, clientVersion=${baseVersion}, serverVersion=${file.version}`
      );
      console.log(`transform failed, fallback sync: socket=${socket.id}, room=${roomId}, file=${fileName}`);
      sendLatestDocument();
      return;
    }

    const syncStatus: SyncStatus = baseVersion === file.version ? "Applied" : "Transformed";
    if (syncStatus === "Applied") {
      console.log(`operation applied directly: socket=${socket.id}, room=${roomId}, file=${fileName}`);
    } else {
      console.log(
        `operation transformed: socket=${socket.id}, room=${roomId}, file=${fileName}, fromBaseVersion=${baseVersion}, currentVersion=${file.version}, transformedPosition=${operationToApply.position}`
      );
    }

    file.code = applyOperation(file.code, operationToApply);
    file.version += 1;
    room.activeFileName = fileName;
    const appliedOperation = {
      ...operationToApply,
      baseVersion,
      appliedVersion: file.version
    };
    storeOperation(file, appliedOperation);
    scheduleWorkspaceSave(roomId, room);

    console.log(`update accepted: socket=${socket.id}, room=${roomId}, file=${fileName}, version=${baseVersion}`);
    console.log(`code accepted: socket=${socket.id}, room=${roomId}, file=${fileName}, version=${baseVersion}`);
    console.log(`version incremented: room=${roomId}, file=${fileName}, version=${file.version}`);
    io.to(roomId).emit("code-change", {
      fileName,
      code: file.code,
      language: file.language,
      version: file.version,
      operation: appliedOperation,
      syncStatus,
      socketId: socket.id
    });
  });

  socket.on("project-create", (payload: ProjectCreatePayload) => {
    if (!payload.roomId) {
      return;
    }

    const room = getJoinedRoom(socket, payload.roomId);
    if (!room) {
      return;
    }
    const node = addProjectNode(room, payload);
    if (!node) {
      socket.emit("project-error", { message: "Could not create item. Check the folder and make sure the name is unique." });
      return;
    }

    console.log(`project-create: socket=${socket.id}, room=${payload.roomId}, type=${node.type}, path=${node.path}`);
    scheduleWorkspaceSave(payload.roomId, room);
    emitProjectUpdate(payload.roomId, room);
  });

  socket.on("project-rename", (payload: ProjectRenamePayload) => {
    if (!payload.roomId) {
      return;
    }

    const room = getJoinedRoom(socket, payload.roomId);
    if (!room) {
      return;
    }
    if (!renameProjectNode(room, payload)) {
      socket.emit("project-error", { message: "Could not rename item." });
      return;
    }

    console.log(`project-rename: socket=${socket.id}, room=${payload.roomId}, path=${payload.path}, name=${payload.name}`);
    scheduleWorkspaceSave(payload.roomId, room);
    emitProjectUpdate(payload.roomId, room);
    emitCursorPositions(payload.roomId);
  });

  socket.on("project-delete", (payload: ProjectDeletePayload) => {
    if (!payload.roomId) {
      return;
    }

    const room = getJoinedRoom(socket, payload.roomId);
    if (!room) {
      return;
    }
    if (!deleteProjectNode(room, payload.path)) {
      socket.emit("project-error", { message: "Could not delete item." });
      return;
    }

    console.log(`project-delete: socket=${socket.id}, room=${payload.roomId}, path=${payload.path}`);
    scheduleWorkspaceSave(payload.roomId, room);
    emitProjectUpdate(payload.roomId, room);
    emitCursorPositions(payload.roomId);
  });

  socket.on("project-upload", (payload: ProjectUploadPayload) => {
    if (!payload.roomId) {
      return;
    }

    const room = getJoinedRoom(socket, payload.roomId);
    if (!room) {
      return;
    }
    if (!replaceRoomWithUploadedProject(room, payload)) {
      socket.emit("project-error", { message: "Could not upload folder. Try a smaller text/code project." });
      return;
    }

    console.log(`project-upload: socket=${socket.id}, room=${payload.roomId}, files=${room.files.size}`);
    scheduleWorkspaceSave(payload.roomId, room);
    emitProjectUpdate(payload.roomId, room);
    emitCursorPositions(payload.roomId);
  });

  socket.on("typing-start", ({ roomId, username }: RoomPayload) => {
    if (!roomId) {
      return;
    }

    const room = getJoinedRoom(socket, roomId);
    if (!room) {
      return;
    }
    if (username) {
      room.users.set(socket.id, { socketId: socket.id, username });
    }
    room.typingUsers.add(socket.id);
    const payload = createTypingPayload(roomId, room, socket.id);
    console.log(`typing-start: room=${roomId}, username=${payload.username}`);
    socket.to(roomId).emit("typing-start", payload);
  });

  socket.on("typing-stop", ({ roomId, username }: RoomPayload) => {
    if (!roomId) {
      return;
    }

    const room = getJoinedRoom(socket, roomId);
    if (!room) {
      return;
    }
    if (username) {
      room.users.set(socket.id, { socketId: socket.id, username });
    }
    room.typingUsers.delete(socket.id);
    const payload = createTypingPayload(roomId, room, socket.id);
    console.log(`typing-stop: room=${roomId}, username=${payload.username}`);
    socket.to(roomId).emit("typing-stop", payload);
  });

  socket.on("execution-start", ({ roomId, fileName, username }: RoomPayload) => {
    if (!roomId) {
      return;
    }

    const room = getJoinedRoom(socket, roomId);
    if (!room) {
      return;
    }
    const storedUser = room.users.get(socket.id);
    room.execution = {
      output: "",
      error: "",
      status: "Running...",
      roomId,
      fileName,
      username: username || storedUser?.username || "Anonymous"
    };
    console.log(`execution-start: room=${roomId}, file=${fileName || "active"}, username=${room.execution.username}`);
    io.to(roomId).emit("execution-start", room.execution);
  });

  socket.on("manual-save", async ({ roomId }: ManualSavePayload) => {
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      const error = new Error("Room is not active.");
      console.error(`manual save failed with error: roomId=${roomId}`, error);
      emitAutosaveStatus(roomId, "failed", error);
      return;
    }

    clearPendingWorkspaceSave(roomId);
    console.log(`manual save requested: socket=${socket.id}, roomId=${roomId}`);
    emitAutosaveStatus(roomId, "saving");
    await saveWorkspaceSnapshot(roomId, room);
  });

  socket.on("language-change", ({ roomId, fileName, language }: LanguageChangePayload) => {
    if (!roomId || !fileName || !starterCodeByLanguage[language]) {
      return;
    }

    const room = getJoinedRoom(socket, roomId);
    if (!room) {
      return;
    }
    const file = getRoomFile(room, fileName);

    if (!file) {
      return;
    }

    const inferredLanguage = inferLanguageFromFileName(file.fileName);
    if (language !== inferredLanguage) {
      console.log(
        `language-change rejected: socket=${socket.id}, room=${roomId}, file=${fileName}, requested=${language}, inferred=${inferredLanguage}`
      );
    }

    file.language = inferredLanguage;
    room.activeFileName = fileName;
    scheduleWorkspaceSave(roomId, room);

    console.log(`Language sync: socket=${socket.id}, room=${roomId}, file=${fileName}, language=${file.language}`);
    io.to(roomId).emit("language-update", {
      fileName: file.fileName,
      language: file.language,
      code: file.code,
      version: file.version,
      syncStatus: "Applied" satisfies SyncStatus
    });
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    removeSocketFromRooms(socket);
  });
});

void Promise.allSettled([connectDatabase(), initializeRedisAdapter()]).finally(() => {
  server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
});
