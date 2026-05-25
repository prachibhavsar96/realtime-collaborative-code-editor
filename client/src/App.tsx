import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

type ActiveUser = {
  socketId: string;
  username?: string;
};

type CursorPosition = {
  socketId: string;
  username: string;
  fileName: string;
  lineNumber: number;
  column: number;
};

type SyncStatus = "Applied" | "Transformed" | "Fallback Resync";
type SaveStatus = "Saved" | "Saving..." | "Save failed";
type ProjectNodeType = "file" | "folder";

type ProjectTreeNode = {
  id: string;
  type: ProjectNodeType;
  name: string;
  path: string;
  children?: ProjectTreeNode[];
};

type LocalFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type LocalDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<LocalFileHandle | LocalDirectoryHandle>;
};

type CodeChangePayload = {
  fileName: string;
  code: string;
  language: SupportedLanguage;
  version: number;
  operation?: TextOperation;
  syncStatus?: SyncStatus;
  socketId?: string;
};

type TextOperation = {
  roomId: string;
  fileName: string;
  username?: string;
  baseVersion: number;
  type: "insert" | "delete";
  position: number;
  text: string;
  length: number;
};

type MonacoContentChange = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

type MonacoChangeEvent = {
  changes: MonacoContentChange[];
};

type MonacoCursorEvent = {
  position?: {
    lineNumber: number;
    column: number;
  } | null;
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

type WorkspaceFile = {
  fileName: string;
  language: SupportedLanguage;
  code: string;
  version: number;
};

type SyncDocumentPayload = {
  files: WorkspaceFile[];
  projectTree: ProjectTreeNode[];
  activeFileName?: string;
  syncStatus?: SyncStatus;
  users: ActiveUser[];
  execution: ExecutionState;
};

type LanguageUpdatePayload = {
  fileName: string;
  code: string;
  language: SupportedLanguage;
  version: number;
  syncStatus?: SyncStatus;
};

type StaleDocumentPayload = {
  files: WorkspaceFile[];
  projectTree: ProjectTreeNode[];
  activeFileName?: string;
  syncStatus?: SyncStatus;
};

type ProjectUpdatePayload = {
  files: WorkspaceFile[];
  projectTree: ProjectTreeNode[];
  activeFileName?: string;
  syncStatus?: SyncStatus;
};

type TypingPayload = {
  roomId: string;
  socketId: string;
  username: string;
  typingUsers: ActiveUser[];
};

type ExecutionState = {
  output: string;
  error: string;
  status: string;
  roomId?: string;
  fileName?: string;
  username?: string;
};

type ExecuteCodeResponse = {
  output?: string;
  error?: string;
  status?: string;
  time?: string | null;
  memory?: number | null;
};

type AutosaveStatusPayload = {
  roomId: string;
  status: "saving" | "saved" | "failed";
  error?: string;
  savedAt?: string;
};

type RoomAccessResponse = {
  roomId: string;
  displayName: string;
  inviteToken?: string;
  inviteLink?: string;
};

type RecentRoom = {
  displayName: string;
  roomId: string;
  inviteToken: string;
  lastOpened: string;
};

type AuthUser = {
  id: number;
  username: string;
};

type AuthResponse = {
  token: string;
  user: AuthUser;
  error?: string;
};

const backendUrl = (import.meta.env.VITE_BACKEND_URL || "http://localhost:4000").replace(/\/$/, "");
const websocketUrl = (import.meta.env.VITE_WEBSOCKET_URL || backendUrl).replace(/\/$/, "");
const authTokenStorageKey = "collabcode_auth_token";
const maxRecentRooms = 10;
const ignoredUploadFolders = new Set(["node_modules", ".git", "dist", "build"]);
const maxUploadFileBytes = 1024 * 1024;
const maxUploadFiles = 500;
const languageOptions: { label: string; value: SupportedLanguage; monacoLanguage: string }[] = [
  { label: "TypeScript", value: "typescript", monacoLanguage: "typescript" },
  { label: "JavaScript", value: "javascript", monacoLanguage: "javascript" },
  { label: "Python", value: "python", monacoLanguage: "python" },
  { label: "Java", value: "java", monacoLanguage: "java" },
  { label: "C++", value: "cpp", monacoLanguage: "cpp" },
  { label: "HTML", value: "html", monacoLanguage: "html" },
  { label: "CSS", value: "css", monacoLanguage: "css" },
  { label: "JSON", value: "json", monacoLanguage: "json" },
  { label: "Text", value: "plaintext", monacoLanguage: "plaintext" }
];

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

const defaultFiles: WorkspaceFile[] = [
  {
    fileName: "src/main.ts",
    language: "typescript",
    code: starterCodeByLanguage.typescript,
    version: 1
  },
  {
    fileName: "app.py",
    language: "python",
    code: starterCodeByLanguage.python,
    version: 1
  },
  {
    fileName: "src/script.js",
    language: "javascript",
    code: starterCodeByLanguage.javascript,
    version: 1
  }
];

const emptyFile: WorkspaceFile = {
  fileName: "",
  language: "plaintext",
  code: "",
  version: 0
};

const defaultProjectTree: ProjectTreeNode[] = [
  {
    id: "src",
    type: "folder",
    name: "src",
    path: "src",
    children: [
      { id: "src/main.ts", type: "file", name: "main.ts", path: "src/main.ts" },
      { id: "src/script.js", type: "file", name: "script.js", path: "src/script.js" }
    ]
  },
  { id: "app.py", type: "file", name: "app.py", path: "app.py" }
];

const filesToRecord = (files: WorkspaceFile[]) =>
  files.reduce<Record<string, WorkspaceFile>>((nextFiles, file) => {
    nextFiles[file.fileName] = file;
    return nextFiles;
  }, {});

const getFileName = (filePath: string) => filePath.split("/").pop() ?? filePath;

const getParentPath = (filePath: string) => filePath.split("/").slice(0, -1).join("/");

const getLanguageLabel = (language: SupportedLanguage) =>
  languageOptions.find((option) => option.value === language)?.label ?? "Text";

const inferLanguageFromFileName = (fileName: string): SupportedLanguage => {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".tsx") || lowerName.endsWith(".ts")) return "typescript";
  if (lowerName.endsWith(".js")) return "javascript";
  if (lowerName.endsWith(".py")) return "python";
  if (lowerName.endsWith(".java")) return "java";
  if (lowerName.endsWith(".cpp")) return "cpp";
  if (lowerName.endsWith(".html")) return "html";
  if (lowerName.endsWith(".css")) return "css";
  if (lowerName.endsWith(".json")) return "json";
  return "plaintext";
};

const isLikelyBinaryText = (content: string) => content.includes("\u0000");

const findTreeNode = (nodes: ProjectTreeNode[], path: string): ProjectTreeNode | null => {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }

    if (node.children) {
      const match = findTreeNode(node.children, path);
      if (match) {
        return match;
      }
    }
  }

  return null;
};

const formatSavedTime = (savedAt?: string) => {
  const date = savedAt ? new Date(savedAt) : new Date();
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
};

const cursorColorClasses = [
  "remote-cursor-color-0",
  "remote-cursor-color-1",
  "remote-cursor-color-2",
  "remote-cursor-color-3",
  "remote-cursor-color-4",
  "remote-cursor-color-5"
];

const getCursorColorClass = (socketId: string) => {
  const hash = Array.from(socketId).reduce((total, char) => total + char.charCodeAt(0), 0);
  return cursorColorClasses[hash % cursorColorClasses.length];
};

const getInitials = (name?: string) => {
  const trimmedName = name?.trim();
  if (!trimmedName) {
    return "?";
  }

  return trimmedName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
};

const formatRecentOpenedTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
};

function App() {
  const [username, setUsername] = useState("");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authToken, setAuthToken] = useState(() => window.localStorage.getItem(authTokenStorageKey) || "");
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState("");
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [displayRoomName, setDisplayRoomName] = useState("");
  const [roomDisplayName, setRoomDisplayName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteCopyStatus, setInviteCopyStatus] = useState("");
  const [roomAccessError, setRoomAccessError] = useState("");
  const [isRoomSubmitting, setIsRoomSubmitting] = useState(false);
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);
  const [joinedRoom, setJoinedRoom] = useState("");
  const [files, setFiles] = useState<Record<string, WorkspaceFile>>(filesToRecord(defaultFiles));
  const [projectTree, setProjectTree] = useState<ProjectTreeNode[]>(defaultProjectTree);
  const [activeFileName, setActiveFileName] = useState(defaultFiles[0].fileName);
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([]);
  const [connectionStatus, setConnectionStatus] = useState("Disconnected");
  const [executionOutput, setExecutionOutput] = useState("Run code to see output here.");
  const [executionError, setExecutionError] = useState("");
  const [executionStatus, setExecutionStatus] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);
  const [typingUsers, setTypingUsers] = useState<ActiveUser[]>([]);
  const [cursorPositions, setCursorPositions] = useState<Record<string, CursorPosition>>({});
  const [lastSyncStatus, setLastSyncStatus] = useState<SyncStatus>("Applied");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("Saved");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [hasSyncedWorkspace, setHasSyncedWorkspace] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [selectedFolderPath, setSelectedFolderPath] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [isUploadingProject, setIsUploadingProject] = useState(false);
  const [socketId, setSocketId] = useState("");
  const [localCursorPosition, setLocalCursorPosition] = useState({ lineNumber: 1, column: 1 });
  const [outputTab, setOutputTab] = useState<"output" | "terminal">("output");
  const socketRef = useRef<Socket | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const cursorSubscriptionRef = useRef<{ dispose: () => void } | null>(null);
  const cursorDecorationsRef = useRef<string[]>([]);
  const cursorWidgetsRef = useRef<any[]>([]);
  const applyingRemoteChange = useRef(false);
  const suppressCursorBroadcastRef = useRef(false);
  const activeFileNameRef = useRef(defaultFiles[0].fileName);
  const documentVersionRef = useRef(1);
  const socketIdRef = useRef("");
  const typingTimeoutRef = useRef<number | null>(null);

  const displayName = useMemo(() => currentUser?.username || username.trim() || "Anonymous", [currentUser, username]);
  const fileList = useMemo(() => Object.values(files), [files]);
  const activeFile = files[activeFileName] ?? fileList[0] ?? emptyFile;
  const code = activeFile.code;
  const language = activeFile.language;
  const inferredLanguage = activeFile.fileName ? inferLanguageFromFileName(activeFile.fileName) : language;
  const documentVersion = activeFile.version;
  const monacoLanguage =
    languageOptions.find((option) => option.value === inferredLanguage)?.monacoLanguage ?? "plaintext";
  const canRunActiveFile = ["typescript", "javascript", "python", "java", "cpp"].includes(inferredLanguage);
  const selectedFolder = selectedFolderPath ? findTreeNode(projectTree, selectedFolderPath) : null;
  const selectedFolderLabel = selectedFolder?.type === "folder" ? selectedFolder.path : "root";
  const visibleTypingUsers = typingUsers.filter((user) => user.socketId !== socketId);
  const visibleCursorPositions = useMemo(
    () =>
      Object.values(cursorPositions).filter(
        (cursor) => cursor.socketId !== socketId && cursor.fileName === activeFileName
      ),
    [activeFileName, cursorPositions, socketId]
  );
  const userStatuses = activeUsers.map((user) => {
    const cursor = cursorPositions[user.socketId];
    const isCurrentUser = user.socketId === socketId;
    const fileName = isCurrentUser ? activeFileName : cursor?.fileName ?? "unknown file";
    const isTyping = typingUsers.some((typingUser) => typingUser.socketId === user.socketId);
    return {
      socketId: user.socketId,
      username: user.username || "Anonymous",
      initials: getInitials(user.username || "Anonymous"),
      colorClass: getCursorColorClass(user.socketId),
      fileName,
      action: isTyping ? "editing" : "viewing"
    };
  });
  const typingMessage =
    visibleTypingUsers.length === 0
      ? ""
      : `${visibleTypingUsers.map((user) => user.username || "Anonymous").join(", ")} ${
          visibleTypingUsers.length === 1 ? "is" : "are"
        } typing...`;

  const authHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`
  });

  const loadRecentRooms = async (token = authToken) => {
    if (!token) {
      setRecentRooms([]);
      return;
    }

    const response = await fetch(`${backendUrl}/rooms/recent`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      setRecentRooms([]);
      return;
    }
    const result = (await response.json()) as { rooms: RecentRoom[] };
    setRecentRooms((result.rooms || []).slice(0, maxRecentRooms));
  };

  const handleAuthSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsAuthSubmitting(true);
    setAuthError("");

    try {
      const response = await fetch(`${backendUrl}/auth/${authMode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username: authUsername,
          password: authPassword
        })
      });
      const result = (await response.json()) as AuthResponse;
      if (!response.ok) {
        throw new Error(result.error || "Authentication failed.");
      }

      window.localStorage.setItem(authTokenStorageKey, result.token);
      setAuthToken(result.token);
      setCurrentUser(result.user);
      setUsername(result.user.username);
      setAuthPassword("");
      await loadRecentRooms(result.token);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const resetRoomSession = () => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setJoinedRoom("");
    setRoomDisplayName("");
    setRoomId("");
    setDisplayRoomName("");
    setInviteToken("");
    setInviteLink("");
    setIsInviteOpen(false);
    setInviteCopyStatus("");
    setRoomAccessError("");
    setFiles(filesToRecord(defaultFiles));
    setProjectTree(defaultProjectTree);
    setActiveFileName(defaultFiles[0].fileName);
    activeFileNameRef.current = defaultFiles[0].fileName;
    updateDocumentVersion(1);
    setActiveUsers([]);
    setTypingUsers([]);
    setCursorPositions({});
    setConnectionStatus("Disconnected");
    setExecutionOutput("Run code to see output here.");
    setExecutionError("");
    setExecutionStatus("");
    setIsExecuting(false);
    setHasSyncedWorkspace(false);
    setProjectError("");
    setSelectedFolderPath("");
    setUploadStatus("");
    setSocketId("");
    socketIdRef.current = "";
  };

  const logout = () => {
    window.localStorage.removeItem(authTokenStorageKey);
    resetRoomSession();
    setAuthToken("");
    setCurrentUser(null);
    setUsername("");
    setRecentRooms([]);
    setAuthPassword("");
    setAuthError("");
  };

  useEffect(() => {
    if (!authToken) {
      return;
    }

    const loadUser = async () => {
      try {
        const response = await fetch(`${backendUrl}/me`, {
          headers: {
            Authorization: `Bearer ${authToken}`
          }
        });
        const result = (await response.json()) as { user?: AuthUser; error?: string };
        if (!response.ok || !result.user) {
          throw new Error(result.error || "Session expired.");
        }
        setCurrentUser(result.user);
        setUsername(result.user.username);
        await loadRecentRooms(authToken);
      } catch {
        logout();
      }
    };

    void loadUser();
  }, [authToken]);

  useEffect(() => {
    const inviteFromUrl = new URLSearchParams(window.location.search).get("invite");
    if (inviteFromUrl) {
      setRoomId(inviteFromUrl);
    }
  }, []);

  const updateDocumentVersion = (nextVersion: number) => {
    documentVersionRef.current = nextVersion;
  };

  const updateFile = (fileName: string, updates: Partial<WorkspaceFile>) => {
    setFiles((currentFiles) => {
      const currentFile = currentFiles[fileName];
      if (!currentFile) {
        return currentFiles;
      }
      return {
        ...currentFiles,
        [fileName]: {
          ...currentFile,
          ...updates
        }
      };
    });
  };

  const applyServerFiles = (
    nextFiles: WorkspaceFile[],
    nextProjectTree: ProjectTreeNode[],
    nextActiveFileName?: string,
    nextSyncStatus?: SyncStatus
  ) => {
    applyingRemoteChange.current = true;
    suppressCursorBroadcastRef.current = true;
    const selection = editorRef.current?.getSelection?.();
    setFiles(filesToRecord(nextFiles));
    setProjectTree(nextProjectTree);
    const serverActiveFileName = nextActiveFileName ?? activeFileNameRef.current;
    const nextActiveFile = nextFiles.find((file) => file.fileName === serverActiveFileName) ?? nextFiles[0];
    if (nextActiveFile) {
      activeFileNameRef.current = nextActiveFile.fileName;
      setActiveFileName(nextActiveFile.fileName);
      updateDocumentVersion(nextActiveFile.version);
    } else {
      activeFileNameRef.current = "";
      setActiveFileName("");
      updateDocumentVersion(0);
    }
    if (nextSyncStatus) {
      setLastSyncStatus(nextSyncStatus);
    }
    window.setTimeout(() => {
      if (selection && editorRef.current) {
        editorRef.current.setSelection(selection);
      }
      applyingRemoteChange.current = false;
      suppressCursorBroadcastRef.current = false;
    }, 0);
  };

  const applyServerFileUpdate = (
    fileName: string,
    nextCode: string,
    nextLanguage: SupportedLanguage,
    nextVersion: number,
    nextSyncStatus?: SyncStatus
  ) => {
    const isActiveFileUpdate = fileName === activeFileNameRef.current;
    applyingRemoteChange.current = isActiveFileUpdate;
    suppressCursorBroadcastRef.current = isActiveFileUpdate;
    const selection = isActiveFileUpdate ? editorRef.current?.getSelection?.() : null;
    updateFile(fileName, {
      code: nextCode,
      language: nextLanguage,
      version: nextVersion
    });
    if (fileName === activeFileNameRef.current) {
      updateDocumentVersion(nextVersion);
    }
    if (nextSyncStatus) {
      setLastSyncStatus(nextSyncStatus);
    }
    window.setTimeout(() => {
      if (selection && editorRef.current) {
        editorRef.current.setSelection(selection);
      }
      applyingRemoteChange.current = false;
      suppressCursorBroadcastRef.current = false;
    }, 0);
  };

  const applyProjectUpdate = (
    nextFiles: WorkspaceFile[],
    nextProjectTree: ProjectTreeNode[],
    nextActiveFileName?: string,
    nextSyncStatus?: SyncStatus
  ) => {
    applyServerFiles(nextFiles, nextProjectTree, nextActiveFileName, nextSyncStatus);
  };

  const applyExecutionState = ({ output, error, status }: ExecutionState) => {
    setExecutionOutput(output || (status === "Running..." ? "" : "No output."));
    setExecutionError(error || "");
    setExecutionStatus(status);
    setIsExecuting(status === "Running...");
  };

  const emitCursorPosition = (lineNumber: number, column: number, fileName = activeFileNameRef.current) => {
    const payload = {
      roomId: joinedRoom,
      fileName,
      username: displayName,
      lineNumber,
      column
    };
    console.log("local cursor sent", payload);
    socketRef.current?.emit("cursor-position", payload);
  };

  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    cursorSubscriptionRef.current?.dispose();
    cursorSubscriptionRef.current = editor.onDidChangeCursorPosition(handleCursorMove);
  };

  const handleCursorMove = (event: MonacoCursorEvent) => {
    if (!event.position) {
      return;
    }

    setLocalCursorPosition(event.position);

    if (suppressCursorBroadcastRef.current) {
      return;
    }

    emitCursorPosition(event.position.lineNumber, event.position.column);
  };

  useEffect(() => {
    if (!joinedRoom) {
      return;
    }

    const socket = io(websocketUrl, {
      auth: { token: authToken },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      timeout: 12000
    });
    socketRef.current = socket;
    setConnectionStatus("Connecting");
    setHasSyncedWorkspace(false);
    setSaveStatus("Saving...");
    setLastSavedAt("");

    socket.on("connect", () => {
      setConnectionStatus("Connected");
      const nextSocketId = socket.id ?? "";
      socketIdRef.current = nextSocketId;
      setSocketId(nextSocketId);
      socket.emit("join-room", {
        roomId: joinedRoom,
        username: displayName
      });
    });

    socket.on("room-joined", ({ roomId, displayName, inviteToken, inviteLink }: RoomAccessResponse) => {
      setJoinedRoom(roomId);
      setRoomDisplayName(displayName);
      if (inviteToken) {
        setInviteToken(inviteToken);
        setInviteLink(inviteLink || `${window.location.origin}/?invite=${encodeURIComponent(inviteToken)}`);
        void loadRecentRooms();
      }
      setRoomAccessError("");
    });

    socket.on("room-access-denied", ({ message }: { message: string }) => {
      setRoomAccessError(message || "Room not found or access denied.");
      setJoinedRoom("");
      setHasSyncedWorkspace(false);
      socket.disconnect();
    });

    socket.on("disconnect", () => {
      setConnectionStatus("Disconnected");
      setActiveUsers([]);
      setTypingUsers([]);
      setCursorPositions({});
      setHasSyncedWorkspace(false);
      socketIdRef.current = "";
      setSocketId("");
    });

    socket.on("connect_error", () => {
      setConnectionStatus("Connection error");
    });

    socket.io.on("reconnect_attempt", () => {
      setConnectionStatus("Reconnecting");
    });

    socket.io.on("reconnect", () => {
      setConnectionStatus("Connected");
    });

    socket.io.on("reconnect_error", () => {
      setConnectionStatus("Reconnecting");
    });

    socket.on("active-users", (users: ActiveUser[]) => {
      setActiveUsers(users);
    });

    socket.on("cursor-position", (cursor: CursorPosition) => {
      if (cursor.socketId === socketIdRef.current) {
        console.log("ignored own cursor event", cursor);
        return;
      }

      console.log("remote cursor received", cursor);
      setCursorPositions((currentCursors) => ({
        ...currentCursors,
        [cursor.socketId]: cursor
      }));
    });

    socket.on("cursor-positions", (cursors: CursorPosition[]) => {
      const remoteCursors = cursors.filter((cursor) => {
        const isOwnCursor = cursor.socketId === socketIdRef.current;
        if (isOwnCursor) {
          console.log("ignored own cursor event", cursor);
        }
        return !isOwnCursor;
      });

      console.log("remote cursor received", remoteCursors);
      setCursorPositions(
        remoteCursors.reduce<Record<string, CursorPosition>>((nextCursors, cursor) => {
          nextCursors[cursor.socketId] = cursor;
          return nextCursors;
        }, {})
      );
    });

    socket.on(
      "sync-document",
      ({ files, projectTree, activeFileName, syncStatus, users, execution }: SyncDocumentPayload) => {
        applyServerFiles(files, projectTree, activeFileName, syncStatus ?? "Applied");
        setActiveUsers(users);
        applyExecutionState(execution);
        setHasSyncedWorkspace(true);
        setSaveStatus("Saved");
      }
    );

    socket.on(
      "code-change",
      ({ fileName, code: incomingCode, language, version, syncStatus }: CodeChangePayload) => {
        applyServerFileUpdate(fileName, incomingCode, language, version, syncStatus ?? "Applied");
      }
    );

    socket.on("language-update", ({ fileName, code, language, version, syncStatus }: LanguageUpdatePayload) => {
      applyServerFileUpdate(fileName, code, language, version, syncStatus ?? "Applied");
    });

    socket.on("stale-document", ({ files, projectTree, activeFileName, syncStatus }: StaleDocumentPayload) => {
      applyServerFiles(files, projectTree, activeFileName, syncStatus ?? "Fallback Resync");
    });

    socket.on("project-update", ({ files, projectTree, activeFileName, syncStatus }: ProjectUpdatePayload) => {
      applyProjectUpdate(files, projectTree, activeFileName, syncStatus ?? "Applied");
    });

    socket.on("project-error", ({ message }: { message: string }) => {
      setProjectError(message);
      window.setTimeout(() => setProjectError(""), 2500);
    });

    socket.on("typing-start", ({ typingUsers }: TypingPayload) => {
      setTypingUsers(typingUsers);
    });

    socket.on("typing-stop", ({ typingUsers }: TypingPayload) => {
      setTypingUsers(typingUsers);
    });

    socket.on("execution-start", (execution: ExecutionState) => {
      applyExecutionState(execution);
    });

    socket.on("execution-result", (execution: ExecutionState) => {
      applyExecutionState(execution);
    });

    socket.on("autosave-status", ({ status, savedAt }: AutosaveStatusPayload) => {
      if (status === "saving") {
        setSaveStatus("Saving...");
      } else if (status === "saved") {
        setSaveStatus("Saved");
        setLastSavedAt(formatSavedTime(savedAt));
      } else {
        setSaveStatus("Save failed");
      }
    });

    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
      }
      cursorWidgetsRef.current.forEach((widget) => editorRef.current?.removeContentWidget(widget));
      cursorWidgetsRef.current = [];
      cursorSubscriptionRef.current?.dispose();
      cursorSubscriptionRef.current = null;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [authToken, displayName, joinedRoom]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return;
    }

    cursorWidgetsRef.current.forEach((widget) => editor.removeContentWidget(widget));
    cursorWidgetsRef.current = [];

    const decorations = visibleCursorPositions.map((cursor) => {
      const colorClass = getCursorColorClass(cursor.socketId);
      return {
        range: new monaco.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
        options: {
          afterContentClassName: `remote-cursor-line ${colorClass}`,
          hoverMessage: { value: `${cursor.username} viewing ${cursor.fileName}` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      };
    });

    cursorDecorationsRef.current = editor.deltaDecorations(cursorDecorationsRef.current, decorations);

    cursorWidgetsRef.current = visibleCursorPositions.map((cursor) => {
      const colorClass = getCursorColorClass(cursor.socketId);
      const node = document.createElement("span");
      node.className = `remote-cursor-badge ${colorClass}`;
      node.textContent = getInitials(cursor.username);
      node.title = `${cursor.username} viewing ${cursor.fileName}`;

      const widget = {
        getId: () => `remote-cursor-widget-${cursor.socketId}`,
        getDomNode: () => node,
        getPosition: () => ({
          position: {
            lineNumber: cursor.lineNumber,
            column: cursor.column
          },
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
        })
      };

      editor.addContentWidget(widget);
      return widget;
    });

    console.log("remote cursor rendered", visibleCursorPositions);
  }, [visibleCursorPositions]);

  useEffect(() => {
    if (!selectedFolderPath) {
      return;
    }

    const node = findTreeNode(projectTree, selectedFolderPath);
    if (!node || node.type !== "folder") {
      setSelectedFolderPath("");
    }
  }, [projectTree, selectedFolderPath]);

  const joinRoom = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await joinRoomWithAccessCode(roomId);
  };

  const joinRoomWithAccessCode = async (accessCodeValue: string) => {
    const accessCode = accessCodeValue.trim();
    if (!accessCode) {
      return;
    }

    setIsRoomSubmitting(true);
    setRoomAccessError("");

    try {
      const response = await fetch(`${backendUrl}/rooms/join`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ accessCode })
      });
      const result = (await response.json()) as RoomAccessResponse & { error?: string };

      if (!response.ok) {
        throw new Error(result.error || "Room not found or access denied.");
      }

      setHasSyncedWorkspace(false);
      setSaveStatus("Saving...");
      setLastSavedAt("");
      setSelectedFolderPath("");
      setRoomDisplayName(result.displayName);
      setInviteToken(result.inviteToken || (accessCode === result.roomId ? "" : accessCode));
      setInviteLink(
        result.inviteLink ||
          (accessCode === result.roomId ? "" : `${window.location.origin}/?invite=${encodeURIComponent(accessCode)}`)
      );
      setJoinedRoom(result.roomId);
      await loadRecentRooms();
    } catch (error) {
      setRoomAccessError(error instanceof Error ? error.message : "Room not found or access denied.");
    } finally {
      setIsRoomSubmitting(false);
    }
  };

  const rejoinRecentRoom = async (room: RecentRoom) => {
    setRoomId(room.inviteToken);
    await joinRoomWithAccessCode(room.inviteToken);
  };

  const removeRecentRoom = async (roomIdToRemove: string) => {
    await fetch(`${backendUrl}/rooms/recent/${encodeURIComponent(roomIdToRemove)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });
    await loadRecentRooms();
  };

  const clearRecentRooms = async () => {
    await fetch(`${backendUrl}/rooms/recent`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });
    setRecentRooms([]);
  };

  const createRoom = async () => {
    setIsRoomSubmitting(true);
    setRoomAccessError("");

    try {
      const response = await fetch(`${backendUrl}/rooms/create`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ displayName: displayRoomName })
      });
      const result = (await response.json()) as RoomAccessResponse & { error?: string };

      if (!response.ok) {
        throw new Error(result.error || "Could not create room.");
      }

      setRoomId(result.inviteToken || result.roomId);
      setRoomDisplayName(result.displayName);
      setInviteToken(result.inviteToken || "");
      setInviteLink(result.inviteLink || `${window.location.origin}/?invite=${encodeURIComponent(result.inviteToken || result.roomId)}`);
      setHasSyncedWorkspace(false);
      setSaveStatus("Saving...");
      setLastSavedAt("");
      setSelectedFolderPath("");
      setJoinedRoom(result.roomId);
      await loadRecentRooms();
    } catch (error) {
      setRoomAccessError(error instanceof Error ? error.message : "Could not create room.");
    } finally {
      setIsRoomSubmitting(false);
    }
  };

  const emitTypingPresence = () => {
    socketRef.current?.emit("typing-start", {
      roomId: joinedRoom,
      username: displayName
    });

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      socketRef.current?.emit("typing-stop", {
        roomId: joinedRoom,
        username: displayName
      });
    }, 1000);
  };

  const createOperationsFromChange = (
    change: MonacoContentChange,
    baseVersion: number
  ): TextOperation[] => {
    const operations: TextOperation[] = [];

    if (change.rangeLength > 0) {
      operations.push({
        roomId: joinedRoom,
        fileName: activeFileName,
        username: displayName,
        baseVersion,
        type: "delete",
        position: change.rangeOffset,
        text: "",
        length: change.rangeLength
      });
    }

    if (change.text.length > 0) {
      operations.push({
        roomId: joinedRoom,
        fileName: activeFileName,
        username: displayName,
        baseVersion,
        type: "insert",
        position: change.rangeOffset,
        text: change.text,
        length: change.text.length
      });
    }

    return operations;
  };

  const handleCodeChange = (value: string | undefined, event?: MonacoChangeEvent) => {
    const nextCode = value ?? "";
    updateFile(activeFileName, { code: nextCode });

    if (applyingRemoteChange.current) {
      applyingRemoteChange.current = false;
      return;
    }

    emitTypingPresence();

    const baseVersion = documentVersionRef.current;
    const operations =
      event?.changes.flatMap((change) => createOperationsFromChange(change, baseVersion)) ?? [];

    if (operations.length > 0) {
      setSaveStatus("Saving...");
    }

    operations.forEach((operation) => {
      console.log("sending operation", operation);
      socketRef.current?.emit("code-change", operation);
    });
  };

  const createProjectItem = (type: ProjectNodeType, parentFolderPath = selectedFolderPath) => {
    const label = type === "file" ? "file" : "folder";
    const targetLabel = parentFolderPath || "root";
    const name = window.prompt(`New ${label} in ${targetLabel}`);
    if (!name?.trim()) {
      return;
    }

    setSaveStatus("Saving...");
    socketRef.current?.emit("project-create", {
      roomId: joinedRoom,
      parentFolderPath,
      type,
      name: name.trim()
    });
  };

  const renameProjectItem = (node: ProjectTreeNode) => {
    const name = window.prompt("Rename", node.name);
    if (!name?.trim() || name.trim() === node.name) {
      return;
    }

    setSaveStatus("Saving...");
    socketRef.current?.emit("project-rename", {
      roomId: joinedRoom,
      path: node.path,
      name: name.trim()
    });
  };

  const deleteProjectItem = (node: ProjectTreeNode) => {
    const confirmed = window.confirm(`Delete ${node.name}?`);
    if (!confirmed) {
      return;
    }

    setSaveStatus("Saving...");
    socketRef.current?.emit("project-delete", {
      roomId: joinedRoom,
      path: node.path
    });
  };

  const uploadProjectFolder = async () => {
    const picker = (window as Window & {
      showDirectoryPicker?: () => Promise<LocalDirectoryHandle>;
    }).showDirectoryPicker;

    if (!picker) {
      setProjectError("Folder upload is not supported in this browser.");
      window.setTimeout(() => setProjectError(""), 3000);
      return;
    }

    setIsUploadingProject(true);
    setUploadStatus("Choosing folder...");

    try {
      const rootHandle = await picker();
      const uploadedFiles: WorkspaceFile[] = [];
      let skippedCount = 0;

      const readDirectory = async (directoryHandle: LocalDirectoryHandle, parentPath = ""): Promise<ProjectTreeNode[]> => {
        const nodes: ProjectTreeNode[] = [];

        for await (const entry of directoryHandle.values()) {
          if (entry.kind === "directory") {
            if (ignoredUploadFolders.has(entry.name)) {
              skippedCount += 1;
              continue;
            }

            const folderPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
            const children = await readDirectory(entry, folderPath);
            nodes.push({
              id: folderPath,
              type: "folder",
              name: entry.name,
              path: folderPath,
              children
            });
            continue;
          }

          if (uploadedFiles.length >= maxUploadFiles) {
            skippedCount += 1;
            continue;
          }

          const file = await entry.getFile();
          const filePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
          if (file.size > maxUploadFileBytes) {
            skippedCount += 1;
            continue;
          }

          const code = await file.text();
          if (isLikelyBinaryText(code)) {
            skippedCount += 1;
            continue;
          }

          const language = inferLanguageFromFileName(filePath);
          uploadedFiles.push({
            fileName: filePath,
            language,
            code,
            version: 1
          });
          nodes.push({
            id: filePath,
            type: "file",
            name: entry.name,
            path: filePath
          });
          setUploadStatus(`Reading ${uploadedFiles.length} files...`);
        }

        return nodes.sort((first, second) => {
          if (first.type !== second.type) {
            return first.type === "folder" ? -1 : 1;
          }
          return first.name.localeCompare(second.name);
        });
      };

      const nextProjectTree = await readDirectory(rootHandle);
      if (uploadedFiles.length === 0) {
        setUploadStatus("");
        setProjectError("No text/code files found in that folder.");
        return;
      }

      setUploadStatus(`Uploading ${uploadedFiles.length} files...`);
      setSaveStatus("Saving...");
      socketRef.current?.emit("project-upload", {
        roomId: joinedRoom,
        files: uploadedFiles.map(({ fileName, code }) => ({ fileName, code })),
        projectTree: nextProjectTree
      });
      setUploadStatus(
        skippedCount > 0
          ? `Uploaded ${uploadedFiles.length} files, skipped ${skippedCount}.`
          : `Uploaded ${uploadedFiles.length} files.`
      );
      window.setTimeout(() => setUploadStatus(""), 3500);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setUploadStatus("");
      } else {
        setProjectError(error instanceof Error ? error.message : "Folder upload failed.");
        window.setTimeout(() => setProjectError(""), 3000);
      }
    } finally {
      setIsUploadingProject(false);
    }
  };

  const switchFile = (fileName: string) => {
    const nextFile = files[fileName];
    if (!nextFile) {
      return;
    }

    applyingRemoteChange.current = true;
    activeFileNameRef.current = fileName;
    setActiveFileName(fileName);
    setSelectedFolderPath(getParentPath(fileName));
    updateDocumentVersion(nextFile.version);
    const position = editorRef.current?.getPosition?.();
    setLocalCursorPosition({
      lineNumber: position?.lineNumber ?? 1,
      column: position?.column ?? 1
    });
    emitCursorPosition(position?.lineNumber ?? 1, position?.column ?? 1, fileName);
    window.setTimeout(() => {
      applyingRemoteChange.current = false;
    }, 0);
  };

  const runCode = async () => {
    socketRef.current?.emit("execution-start", {
      roomId: joinedRoom,
      fileName: activeFileName,
      username: displayName
    });

    try {
      const response = await fetch(`${backendUrl}/execute`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          roomId: joinedRoom,
          fileName: activeFileName,
          username: displayName,
          language: inferredLanguage,
          code
        })
      });

      const result = (await response.json()) as ExecuteCodeResponse;

      if (!response.ok) {
        throw new Error(result.error || "Code execution failed.");
      }

      applyExecutionState({
        output: result.output || "No output.",
        error: result.error || "",
        status: result.status || "Finished"
      });
    } catch (error) {
      applyExecutionState({
        output: "",
        error: error instanceof Error ? error.message : "Code execution failed.",
        status: "Error"
      });
    }
  };

  const saveWorkspace = () => {
    if (!joinedRoom || !hasSyncedWorkspace) {
      return;
    }

    setSaveStatus("Saving...");
    socketRef.current?.emit("manual-save", {
      roomId: joinedRoom
    });
  };

  const copyRoomId = async () => {
    if (!inviteToken || !inviteLink) {
      setInviteCopyStatus("Invite not ready");
      return;
    }

    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteCopyStatus("Invite link copied");
      window.setTimeout(() => setInviteCopyStatus(""), 2200);
    } catch {
      window.prompt("Copy invite link", inviteLink);
    }
  };

  const clearOutput = () => {
    setExecutionOutput("Run code to see output here.");
    setExecutionError("");
    setExecutionStatus("");
  };

  const leaveRoom = () => {
    setJoinedRoom("");
    setConnectionStatus("Disconnected");
    setHasSyncedWorkspace(false);
    setActiveUsers([]);
    setTypingUsers([]);
    setCursorPositions({});
    setIsInviteOpen(false);
    setInviteCopyStatus("");
  };

  const renderProjectNode = (node: ProjectTreeNode, depth = 0) => {
    const isActive = node.type === "file" && node.path === activeFileName;
    const isSelectedFolder = node.type === "folder" && node.path === selectedFolderPath;
    const file = node.type === "file" ? files[node.path] : null;

    return (
      <div className="tree-node" key={node.path}>
        <div
          className={`tree-row ${isActive ? "active" : ""} ${isSelectedFolder ? "selected-folder" : ""}`}
          onContextMenu={(event) => {
            if (node.type !== "folder") {
              return;
            }

            event.preventDefault();
            setSelectedFolderPath(node.path);
            createProjectItem("file", node.path);
          }}
          style={{ paddingLeft: `${0.55 + depth * 0.85}rem` }}
        >
          <button
            className="tree-main"
            type="button"
            onClick={() => {
              if (node.type === "file") {
                switchFile(node.path);
              } else {
                setSelectedFolderPath(node.path);
              }
            }}
          >
            <span className="tree-glyph">{node.type === "folder" ? "v" : "-"}</span>
            <span className="tree-name">{node.name}</span>
            {file ? <small>v{file.version}</small> : null}
          </button>
          <div className="tree-actions">
            {node.type === "folder" ? (
              <>
                <button type="button" title="New file" onClick={() => createProjectItem("file", node.path)}>
                  +
                </button>
                <button type="button" title="New folder" onClick={() => createProjectItem("folder", node.path)}>
                  /
                </button>
              </>
            ) : null}
            <button type="button" title="Rename" onClick={() => renameProjectItem(node)}>
              R
            </button>
            <button type="button" title="Delete" onClick={() => deleteProjectItem(node)}>
              x
            </button>
          </div>
        </div>
        {node.children?.map((child) => renderProjectNode(child, depth + 1))}
      </div>
    );
  };

  if (!currentUser) {
    return (
      <main className="home-page">
        <form className="join-panel auth-panel" onSubmit={handleAuthSubmit}>
          <div>
            <p className="eyebrow">CollabCode</p>
            <h1>{authMode === "login" ? "Log in" : "Create account"}</h1>
          </div>
          <p className="session-helper">
            Secure collaborative coding workspace.
          </p>

          <label>
            Username
            <input
              value={authUsername}
              onChange={(event) => setAuthUsername(event.target.value)}
              placeholder="ada"
              autoComplete="username"
              required
            />
          </label>

          <label>
            Password
            <input
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              placeholder="At least 6 characters"
              type="password"
              autoComplete={authMode === "login" ? "current-password" : "new-password"}
              required
            />
          </label>

          {authError ? <div className="project-error">{authError}</div> : null}

          <button type="submit" disabled={isAuthSubmitting}>
            {isAuthSubmitting ? "Please wait..." : authMode === "login" ? "Log in" : "Register"}
          </button>

          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setAuthMode(authMode === "login" ? "register" : "login");
              setAuthError("");
            }}
          >
            {authMode === "login" ? "Create an account" : "Use existing account"}
          </button>
        </form>
      </main>
    );
  }

  if (!joinedRoom) {
    return (
      <main className="home-page">
        <div className="landing-shell">
          <form className="join-panel" onSubmit={joinRoom}>
            <div>
              <p className="eyebrow">Realtime editor</p>
              <h1>{currentUser.username}'s workspaces</h1>
            </div>

            <div className="dashboard-user-row">
              <span>Logged in as <strong>{currentUser.username}</strong></span>
              <button type="button" className="ghost-button" onClick={logout}>
                Logout
              </button>
            </div>

            <label>
              Join with invite code
              <input
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
                placeholder="Paste invite code or secure room ID"
              />
            </label>

            {roomAccessError ? <div className="project-error">{roomAccessError}</div> : null}

            <button type="submit" disabled={isRoomSubmitting || !roomId.trim()}>
              {isRoomSubmitting ? "Checking..." : "Join Room"}
            </button>

            <div className="join-divider">or</div>

            <label>
              Display room name
              <input
                value={displayRoomName}
                onChange={(event) => setDisplayRoomName(event.target.value)}
                placeholder="Room Name"
              />
            </label>

            <button type="button" className="ghost-button" onClick={createRoom} disabled={isRoomSubmitting}>
              Create Room
            </button>

            {inviteToken ? (
              <div className="invite-card">
                <span>Invite code</span>
                <strong>{inviteToken}</strong>
                <button type="button" onClick={copyRoomId}>Copy invite link</button>
              </div>
            ) : null}
          </form>

          <section className="recent-panel">
              <div className="recent-header">
                <div>
                  <p className="eyebrow">History</p>
                  <h2>Recent Workspaces</h2>
                </div>
                {recentRooms.length > 0 ? (
                  <button type="button" className="ghost-button" onClick={clearRecentRooms}>
                    Clear history
                  </button>
                ) : null}
              </div>
              <p className="recent-helper">Recent rooms are saved to your account.</p>

              {recentRooms.length === 0 ? (
                <div className="recent-empty">Created and joined rooms for {currentUser.username} will appear here.</div>
              ) : (
                <div className="recent-list">
                  {recentRooms.map((room) => (
                    <article className="recent-card" key={`${room.roomId}-${room.inviteToken}`}>
                      <div>
                        <strong>{room.displayName}</strong>
                        <span>Last opened {formatRecentOpenedTime(room.lastOpened)}</span>
                      </div>
                      <div className="recent-actions">
                        <button type="button" onClick={() => rejoinRecentRoom(room)} disabled={isRoomSubmitting}>
                          Rejoin
                        </button>
                        <button type="button" className="ghost-button" onClick={() => removeRecentRoom(room.roomId)}>
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="editor-page">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">CC</div>
          <div>
            <strong>CollabCode</strong>
            <span>Logged in as {displayName}</span>
          </div>
        </div>

        <div className="topbar-center">
          <div className="room-pill">
            <span>Room</span>
            <strong>{roomDisplayName || joinedRoom}</strong>
          </div>
          <div className="invite-menu">
            <button
              className="invite-button"
              type="button"
              onClick={() => {
                setIsInviteOpen((isOpen) => !isOpen);
                setInviteCopyStatus("");
              }}
            >
              Invite
            </button>
            {isInviteOpen ? (
              <div className="invite-popover" role="dialog" aria-label="Invite details">
                <div className="invite-popover-header">
                  <span>Invite</span>
                  <button type="button" onClick={() => setIsInviteOpen(false)} aria-label="Close invite popover">
                    x
                  </button>
                </div>
                <label>
                  Room
                  <input value={roomDisplayName || "Untitled room"} readOnly />
                </label>
                <label>
                  Invite code
                  <input value={inviteToken || "Invite not ready"} readOnly />
                </label>
                <label>
                  Invite link
                  <input value={inviteLink || "Invite not ready"} readOnly />
                </label>
                <button type="button" onClick={copyRoomId} disabled={!inviteToken || !inviteLink}>
                  Copy Invite Link
                </button>
                <div className={`invite-copy-status ${inviteToken && inviteLink ? "ready" : ""}`}>
                  {inviteCopyStatus || (!inviteToken || !inviteLink ? "Invite not ready" : "")}
                </div>
              </div>
            ) : null}
          </div>
          <div className={`live-pill ${connectionStatus === "Connected" ? "online" : ""}`}>
            <span className="status-dot" />
            {connectionStatus === "Connected" ? "Live" : connectionStatus}
          </div>
          <div className="avatar-stack" aria-label="Active users">
            {userStatuses.slice(0, 5).map((user) => (
              <span key={user.socketId} className={`presence-badge ${user.colorClass}`} title={user.username}>
                {user.initials}
              </span>
            ))}
            {userStatuses.length > 5 ? <span className="avatar-more">+{userStatuses.length - 5}</span> : null}
          </div>
        </div>

        <div className="topbar-meta">
          <span className="meta-badge sync-mode">OT</span>
          <span className="meta-badge">v{documentVersion}</span>
          {inviteToken ? <span className="meta-badge">Invite ready</span> : null}
          <span className={`meta-badge save-status ${saveStatus === "Save failed" ? "failed" : ""}`}>
            {saveStatus}
          </span>
          <button className="ghost-button" type="button" onClick={saveWorkspace} disabled={!hasSyncedWorkspace || saveStatus === "Saving..."}>
            Save
          </button>
          <button className="leave-button" type="button" onClick={leaveRoom}>
            Leave room
          </button>
          <button className="ghost-button" type="button" onClick={logout}>
            Logout
          </button>
        </div>
      </header>

      <div className="app-shell">
        <aside className="sidebar">
          <div className="explorer-header">
            <h2>Explorer</h2>
            <div className="explorer-actions">
              <button type="button" title={`New file in ${selectedFolderLabel}`} onClick={() => createProjectItem("file")}>
                + File
              </button>
              <button type="button" title={`New folder in ${selectedFolderLabel}`} onClick={() => createProjectItem("folder")}>
                + Folder
              </button>
              <button type="button" title="Upload folder" onClick={uploadProjectFolder} disabled={isUploadingProject}>
                Upload
              </button>
            </div>
          </div>
          <div className="selected-folder-label">New items: {selectedFolderLabel}</div>
          {uploadStatus ? <div className="upload-status">{uploadStatus}</div> : null}
          {projectError ? <div className="project-error">{projectError}</div> : null}
          <div className="project-tree">
            {projectTree.length === 0 ? (
              <div className="empty-tree">No files yet</div>
            ) : (
              projectTree.map((node) => renderProjectNode(node))
            )}
          </div>

          <div className="active-file-card">
            <span>Active file</span>
            <strong>{activeFile.fileName || "No file selected"}</strong>
            <small>{getLanguageLabel(inferredLanguage)} | v{documentVersion}</small>
          </div>

          <section className="sidebar-users">
            <h2>Active users</h2>
          <ul className="user-list">
            {userStatuses.length === 0 ? (
              <li>No active users yet</li>
            ) : (
              userStatuses.map((user) => (
                <li key={user.socketId}>
                  <span className={`presence-badge ${user.colorClass}`}>{user.initials}</span>
                  <div>
                    <strong>{user.username}</strong>
                    <span>
                      {user.action} {user.fileName}
                    </span>
                  </div>
                </li>
              ))
            )}
          </ul>
          </section>
        </aside>

        <section className="workspace">
          <div className="file-tabs">
            {fileList.map((file) => (
              <button
                className={`file-tab ${file.fileName === activeFileName ? "active" : ""}`}
                key={file.fileName}
                type="button"
                onClick={() => switchFile(file.fileName)}
              >
                <span>{getFileName(file.fileName)}</span>
                <small>{getLanguageLabel(file.language)}</small>
              </button>
            ))}
          </div>

          <section className="editor-card">
            <header className="editor-header">
              <div>
                <p className="eyebrow">Editing</p>
                <strong>{activeFile.fileName || "No file"}</strong>
              </div>
              <div className="editor-actions">
                <button className="run-button" type="button" onClick={runCode} disabled={isExecuting || !canRunActiveFile || !activeFile.fileName}>
                  {isExecuting ? "Running..." : "Run Code"}
                </button>
                <label className="language-picker">
                  <span>Language</span>
                  <span className="language-readout">{getLanguageLabel(inferredLanguage)}</span>
                </label>
                <button className="icon-button" type="button" title={`Last sync: ${lastSyncStatus}`}>
                  ...
                </button>
              </div>
            </header>

            {typingMessage ? <div className="typing-banner">{typingMessage}</div> : null}

            {hasSyncedWorkspace ? (
              <div className="editor-shell">
                <Editor
                  height="560px"
                  language={monacoLanguage}
                  theme="vs"
                  value={code}
                  onMount={handleEditorMount}
                  onChange={handleCodeChange}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    padding: { top: 16, bottom: 16 }
                  }}
                />
              </div>
            ) : (
              <div className="editor-shell loading-workspace">Loading workspace...</div>
            )}

            <div className="status-bar">
              <span><span className="status-dot online" /> Connected</span>
              <span>Secure</span>
              <span>Operational Transformation</span>
              <span>Ln {localCursorPosition.lineNumber}, Col {localCursorPosition.column}</span>
              <span>{getLanguageLabel(inferredLanguage)}</span>
              <span>Saved {lastSavedAt || "--:--:--"}</span>
            </div>
          </section>

          <section className="output-panel">
            <div className="output-header">
              <div className="panel-tabs">
                <button className={outputTab === "output" ? "active" : ""} type="button" onClick={() => setOutputTab("output")}>
                  Output
                </button>
                <button className={outputTab === "terminal" ? "active" : ""} type="button" onClick={() => setOutputTab("terminal")}>
                  Terminal
                </button>
              </div>
              <div className="output-actions">
                <span>{executionStatus || "Idle"}</span>
                <button type="button" onClick={clearOutput}>Clear</button>
              </div>
            </div>
            <pre className={executionError ? "output-error" : ""}>
              {outputTab === "terminal"
                ? `${executionStatus || "Ready"}\n${executionError || executionOutput}`
                : executionError || executionOutput}
            </pre>
          </section>
        </section>
      </div>
    </main>
  );
}

export default App;
