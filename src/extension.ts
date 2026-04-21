/**
 * @Author: Fengze Han
 * @Date:   2025-09-24 00:14:34
 * @Last Modified by:   Fengze Han
 * @Last Modified time: 2025-09-24 10:45:39
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

interface ConversationContent {
  session: string;
  sessionTitle: string;
  date: string;
  human: string;
  copilot: string;
}

interface CopilotEntry {
  key: string;
  content: ConversationContent;
  timestamp?: string;
  workspace?: string;
  type?: string;
}

interface WorkspaceCandidate {
  workspaceDir: string;
  chatSessionsPath: string;
  sessionFiles: string[];
  mostRecentTime: number;
  workspaceFolderPath?: string;
  workspaceLabel?: string;  // human-readable name (folder name or .code-workspace name)
}

interface ExportOptions {
  format: 'json' | 'markdown' | 'both';
  workspaceScope: 'current' | 'all' | 'pick';
  sinceDate: Date | null;
  pickedCandidates?: WorkspaceCandidate[];  // populated when scope === 'pick'
}

// Normalises text without stripping code blocks, so code snippets are preserved in exports.
function cleanText(text: string): string {
  if (!text) { return ''; }
  return text
    .replace(/\n{3,}/g, '\n\n') // Collapse excessive blank lines
    .trim();
}

function getSessionTitle(chatSession: any, firstMessageText?: string): string {
  // JSONL format uses customTitle; JSON format uses name
  if (typeof chatSession?.customTitle === 'string' && chatSession.customTitle.trim().length > 0) {
    return chatSession.customTitle.trim();
  }
  if (typeof chatSession?.name === 'string' && chatSession.name.trim().length > 0) {
    return chatSession.name.trim();
  }
  if (firstMessageText && firstMessageText.trim().length > 0) {
    const cleaned = firstMessageText.trim().replace(/\s+/g, ' ');
    return cleaned.length > 60 ? cleaned.substring(0, 57) + '...' : cleaned;
  }
  return 'Untitled Session';
}

// Returns all existing VS Code storage paths (stable + Insiders).
function getVSCodeStoragePaths(): string[] {
  const platform = os.platform();
  const homedir = os.homedir();
  const candidates: string[] = [];

  switch (platform) {
    case 'win32':
      candidates.push(path.join(homedir, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'));
      candidates.push(path.join(homedir, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'));
      break;
    case 'darwin':
      candidates.push(path.join(homedir, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
      candidates.push(path.join(homedir, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'));
      break;
    default: // Linux and others
      candidates.push(path.join(homedir, '.config', 'Code', 'User', 'workspaceStorage'));
      candidates.push(path.join(homedir, '.config', 'Code - Insiders', 'User', 'workspaceStorage'));
      break;
  }

  return candidates.filter(p => fs.existsSync(p));
}

function normalizePathForCompare(inputPath: string): string {
  const normalized = path.normalize(inputPath).replace(/[\\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsLikelyMatch(pathA: string, pathB: string): boolean {
  const a = normalizePathForCompare(pathA);
  const b = normalizePathForCompare(pathB);

  if (a === b) {
    return true;
  }

  const sep = path.sep;
  return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

interface WorkspaceMetadata {
  folderPath?: string;
  label?: string;
}

function getWorkspaceMetadataFromJson(workspaceStoragePath: string, workspaceDir: string): WorkspaceMetadata {
  const workspaceJsonPath = path.join(workspaceStoragePath, workspaceDir, 'workspace.json');
  if (!fs.existsSync(workspaceJsonPath)) {
    return {};
  }

  try {
    const workspaceJsonRaw = fs.readFileSync(workspaceJsonPath, 'utf8');
    const workspaceJson = JSON.parse(workspaceJsonRaw);

    // Case 1: single-folder workspace → { "folder": "file:///path/to/folder" }
    const folder = workspaceJson?.folder;
    if (typeof folder === 'string') {
      const folderPath = folder.startsWith('file://') ? vscode.Uri.parse(folder).fsPath : folder;
      return { folderPath, label: path.basename(folderPath) };
    }
    if (folder && typeof folder === 'object' && typeof folder.path === 'string') {
      return { folderPath: folder.path, label: path.basename(folder.path) };
    }

    // Case 2: multi-root workspace → { "workspace": "file:///path/to/file.code-workspace" }
    const workspace = workspaceJson?.workspace;
    if (typeof workspace === 'string') {
      const workspacePath = workspace.startsWith('file://') ? vscode.Uri.parse(workspace).fsPath : workspace;
      // Use the .code-workspace file's parent dir as the effective folder for matching
      const parentDir = path.dirname(workspacePath);
      const wsFileName = path.basename(workspacePath); // e.g. BTL.code-workspace
      return { folderPath: parentDir, label: wsFileName };
    }
  } catch {
    // Ignore malformed metadata
  }

  return {};
}

// Kept for backward-compat usage inside resolveCurrentWorkspaceHash
function getWorkspaceFolderFromMetadata(workspaceStoragePath: string, workspaceDir: string): string | undefined {
  return getWorkspaceMetadataFromJson(workspaceStoragePath, workspaceDir).folderPath;
}

function collectWorkspaceCandidates(workspaceStoragePath: string): WorkspaceCandidate[] {
  const workspaceDirs = fs.readdirSync(workspaceStoragePath);
  const candidates: WorkspaceCandidate[] = [];

  for (const workspaceDir of workspaceDirs) {
    const chatSessionsPath = path.join(workspaceStoragePath, workspaceDir, 'chatSessions');
    if (!fs.existsSync(chatSessionsPath)) {
      continue;
    }

    const sessionFiles = fs.readdirSync(chatSessionsPath).filter(
      (f: string) => f.endsWith('.json') || f.endsWith('.jsonl')
    );
    if (sessionFiles.length === 0) {
      continue;
    }

    let mostRecentTime = 0;
    for (const file of sessionFiles) {
      const stat = fs.statSync(path.join(chatSessionsPath, file));
      if (stat.mtime.getTime() > mostRecentTime) {
        mostRecentTime = stat.mtime.getTime();
      }
    }

    const meta = getWorkspaceMetadataFromJson(workspaceStoragePath, workspaceDir);
    candidates.push({
      workspaceDir,
      chatSessionsPath,
      sessionFiles,
      mostRecentTime,
      workspaceFolderPath: meta.folderPath,
      workspaceLabel: meta.label ?? workspaceDir.substring(0, 8)  // fallback to short hash
    });
  }

  return candidates;
}

async function resolveCurrentWorkspaceHash(
  workspaceStoragePath: string,
  diagnostics: string[]
): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    diagnostics.push('No workspace folder is currently open');
    return null;
  }

  const currentWorkspacePaths = folders.map((folder: vscode.WorkspaceFolder) => folder.uri.fsPath);
  diagnostics.push(`Current workspace folders: ${currentWorkspacePaths.join(', ')}`);
  diagnostics.push(`Checking VS Code storage: ${workspaceStoragePath}`);

  const candidates = collectWorkspaceCandidates(workspaceStoragePath);
  diagnostics.push(`Found ${candidates.length} workspace directories with chat session files`);

  if (candidates.length === 0) {
    return null;
  }

  const exactMatches = candidates.filter((candidate) =>
    candidate.workspaceFolderPath &&
    currentWorkspacePaths.some((workspacePath: string) =>
      pathsLikelyMatch(candidate.workspaceFolderPath as string, workspacePath)
    )
  );

  if (exactMatches.length > 0) {
    const bestMatch = exactMatches.sort((a, b) => b.mostRecentTime - a.mostRecentTime)[0];
    diagnostics.push(`Matched workspace via workspace.json: ${bestMatch.workspaceDir}`);
    return bestMatch.workspaceDir;
  }

  const fallbackMatch = candidates.sort((a, b) => b.mostRecentTime - a.mostRecentTime)[0];
  diagnostics.push(`No exact workspace match found, using latest active workspace: ${fallbackMatch.workspaceDir}`);
  return fallbackMatch.workspaceDir;
}

function getSessionId(chatSession: any, sessionFile: string): string {
  if (typeof chatSession?.sessionId === 'string' && chatSession.sessionId.length > 0) {
    return chatSession.sessionId;
  }
  return sessionFile.replace(/\.json$/, '');
}

function getSessionCreationDate(chatSession: any): number {
  if (typeof chatSession?.creationDate === 'number') {
    return chatSession.creationDate;
  }
  if (typeof chatSession?.lastMessageDate === 'number') {
    return chatSession.lastMessageDate;
  }
  return Date.now();
}

/**
 * Extracts the plain-text response from a response parts array.
 * Works for both old JSON format (parts have .value string directly)
 * and new JSONL format (text parts have no "kind" field; other parts
 * like toolInvocationSerialized, thinking, etc. have a kind string).
 */
function extractCopilotResponseText(responseParts: any[]): string {
  const texts: string[] = [];
  for (const part of responseParts) {
    if (!part || typeof part !== 'object') { continue; }
    const hasKind = 'kind' in part && part.kind !== null && part.kind !== undefined;
    if (!hasKind && typeof part.value === 'string' && part.value.trim().length > 0) {
      // JSONL text part: { value: "...", supportThemeIcons, supportHtml, baseUri }
      texts.push(cleanText(part.value));
    } else if (!hasKind && typeof part.value === 'string') {
      // skip empty
    } else if (typeof part.value === 'string' && part.value.trim().length > 0) {
      // old JSON format: parts that have a string .value regardless of kind
      texts.push(cleanText(part.value));
    }
  }
  return texts.join('\n').trim();
}

/**
 * Reads a .jsonl chat session file and returns the complete session object
 * by applying delta operations on top of the kind=0 snapshot.
 *
 * Delta format:
 *   kind=0  { v: { ...full session with requests[] } }   ← base snapshot
 *   kind=2  { k: ["requests"], v: [requestObj] }         ← APPEND new request
 *   kind=2  { k: ["requests", N, "response"], v: [...] } ← EXTEND response of req N
 *   kind=1  (various property updates — mostly ignored for export purposes)
 */
function parseJsonlSessionFile(content: string): any | null {
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  let session: any = null;

  for (const line of lines) {
    try {
      const delta = JSON.parse(line);

      if (delta.kind === 0 && delta.v && Array.isArray(delta.v.requests)) {
        // Base snapshot — deep-clone to avoid mutating parsed JSON
        session = JSON.parse(JSON.stringify(delta.v));
        continue;
      }

      if (!session) { continue; }  // haven't seen snapshot yet

      if (delta.kind === 2 && Array.isArray(delta.k) && Array.isArray(delta.v)) {
        const k = delta.k;

        if (k.length === 1 && k[0] === 'requests') {
          // Append new request(s) added after snapshot
          for (const newReq of delta.v) {
            if (newReq && typeof newReq === 'object' && newReq.requestId) {
              // Avoid duplicates (some requests may already be in snapshot)
              const exists = session.requests.some(
                (r: any) => r.requestId === newReq.requestId
              );
              if (!exists) {
                session.requests.push(newReq);
              }
            }
          }
        } else if (k.length === 3 && k[0] === 'requests' && k[2] === 'response') {
          // Extend/replace response parts for an existing request
          const reqIndex = k[1] as number;
          if (reqIndex >= 0 && reqIndex < session.requests.length) {
            const existingResp: any[] = session.requests[reqIndex].response || [];
            // Append new parts not already present (dedup by simple stringify)
            const existingSet = new Set(existingResp.map((p: any) => JSON.stringify(p)));
            for (const part of delta.v) {
              const key = JSON.stringify(part);
              if (!existingSet.has(key)) {
                existingResp.push(part);
                existingSet.add(key);
              }
            }
            session.requests[reqIndex].response = existingResp;
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return session;
}


async function scanChatSessionsInDirectory(
  chatSessionsPath: string,
  workspaceHash: string,
  options: ExportOptions,
  allEntries: CopilotEntry[],
  diagnostics: string[]
): Promise<void> {
  const allFiles = fs.readdirSync(chatSessionsPath);
  const jsonFiles  = allFiles.filter((f: string) => f.endsWith('.json'));
  const jsonlFiles = allFiles.filter((f: string) => f.endsWith('.jsonl'));
  diagnostics.push(`Found ${jsonFiles.length} JSON + ${jsonlFiles.length} JSONL session files in ${chatSessionsPath}`);

  // Combine; .jsonl files are the newer Agent format
  const sessionFiles = [...jsonFiles, ...jsonlFiles];

  for (const sessionFile of sessionFiles) {
    const isJsonl = sessionFile.endsWith('.jsonl');
    try {
      const filePath = path.join(chatSessionsPath, sessionFile);
      const content = await readFile(filePath, 'utf8');

      // Parse session object depending on format
      const chatSession = isJsonl
        ? parseJsonlSessionFile(content)
        : JSON.parse(content);

      if (!chatSession) { continue; }  // couldn't parse or no snapshot line

      const sessionId = getSessionId(chatSession, sessionFile.replace(/\.jsonl$/, '.json'));
      const sessionCreationTimestamp = getSessionCreationDate(chatSession);
      const sessionDate = new Date(sessionCreationTimestamp).toLocaleDateString();

      // Date filter
      if (options.sinceDate && sessionCreationTimestamp < options.sinceDate.getTime()) {
        continue;
      }

      if (!chatSession.requests || chatSession.requests.length === 0) {
        continue;
      }

      const firstMessageText: string = chatSession.requests[0]?.message?.text ?? '';
      const sessionTitle = getSessionTitle(chatSession, firstMessageText);

      for (let i = 0; i < chatSession.requests.length; i++) {
        const request = chatSession.requests[i];

        if (!request.message?.text) {
          continue;
        }

        const userMessage = cleanText(request.message.text);

        let copilotResponse = 'No response';
        if (request.response && Array.isArray(request.response)) {
          const extracted = extractCopilotResponseText(request.response);
          if (extracted.length > 0) {
            copilotResponse = extracted;
          }
        }

        if (userMessage.length > 10 && copilotResponse.length > 10) {
          allEntries.push({
            key: `${sessionId.substring(0, 8)}-${i + 1}`,
            content: {
              session: sessionId.substring(0, 8),
              sessionTitle,
              date: sessionDate,
              human: userMessage,
              copilot: copilotResponse
            },
            workspace: workspaceHash,
            type: 'conversation'
          });
        }
      }
    } catch (error) {
      diagnostics.push(`Error reading session file ${sessionFile}: ${error}`);
    }
  }
}

async function scanChatSessionFiles(
  allEntries: CopilotEntry[],
  diagnostics: string[],
  options: ExportOptions
): Promise<void> {
  const storagePaths = getVSCodeStoragePaths();

  if (storagePaths.length === 0) {
    diagnostics.push('No VS Code workspace storage directory found (checked stable and Insiders paths)');
    return;
  }

  if (options.workspaceScope === 'current') {
    let found = false;
    for (const storagePath of storagePaths) {
      const hash = await resolveCurrentWorkspaceHash(storagePath, diagnostics);
      if (hash) {
        const chatSessionsPath = path.join(storagePath, hash, 'chatSessions');
        if (fs.existsSync(chatSessionsPath)) {
          diagnostics.push(`Looking for chat sessions in: ${chatSessionsPath}`);
          await scanChatSessionsInDirectory(chatSessionsPath, hash, options, allEntries, diagnostics);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      diagnostics.push('No chat sessions found for the current workspace');
    }
  } else if (options.workspaceScope === 'pick' && options.pickedCandidates) {
    // User explicitly picked specific workspace(s)
    for (const candidate of options.pickedCandidates) {
      diagnostics.push(`Scanning picked workspace: ${candidate.workspaceLabel ?? candidate.workspaceDir}`);
      await scanChatSessionsInDirectory(
        candidate.chatSessionsPath,
        candidate.workspaceDir,
        options,
        allEntries,
        diagnostics
      );
    }
  } else {
    // All workspaces across all storage paths
    for (const storagePath of storagePaths) {
      const candidates = collectWorkspaceCandidates(storagePath);
      diagnostics.push(`Found ${candidates.length} workspaces with chat sessions in ${storagePath}`);
      for (const candidate of candidates) {
        await scanChatSessionsInDirectory(
          candidate.chatSessionsPath,
          candidate.workspaceDir,
          options,
          allEntries,
          diagnostics
        );
      }
    }
  }

  diagnostics.push(`Total: ${allEntries.length} valid conversations found`);
}

function entriesToMarkdown(entries: CopilotEntry[]): string {
  const lines: string[] = [
    '# GitHub Copilot Chat Export',
    '',
    `**Exported:** ${new Date().toLocaleString()}`,
    `**Total conversations:** ${entries.length}`,
    '',
    '---',
    ''
  ];

  let currentSessionKey = '';
  let convIndex = 0;

  for (const entry of entries) {
    const c = entry.content;
    const sessionKey = `${c.session}|${c.date}`;

    if (sessionKey !== currentSessionKey) {
      if (currentSessionKey !== '') {
        lines.push('', '---', '');
      }
      lines.push(`## ${c.sessionTitle}`, '');
      lines.push(`*Date: ${c.date} — Session: ${c.session}*`, '');
      currentSessionKey = sessionKey;
      convIndex = 0;
    }

    convIndex++;
    lines.push(`### Q${convIndex}`);
    lines.push('');
    lines.push(c.human);
    lines.push('');
    lines.push(`### A${convIndex}`);
    lines.push('');
    lines.push(c.copilot);
    lines.push('');
  }

  return lines.join('\n');
}

async function promptExportOptions(): Promise<ExportOptions | undefined> {
  const config = vscode.workspace.getConfiguration('copilotExporter');

  // Format selection
  const formatSetting = config.get<string>('exportFormat', 'json');
  const formatItems: Array<{ label: string; description: string; value: 'json' | 'markdown' | 'both' }> = [
    { label: 'JSON', description: 'Machine-readable JSON file', value: 'json' },
    { label: 'Markdown', description: 'Human-readable Markdown file', value: 'markdown' },
    { label: 'Both', description: 'JSON + Markdown files', value: 'both' }
  ];
  const formatPick = await vscode.window.showQuickPick(formatItems, {
    placeHolder: `Select export format (default: ${formatSetting})`
  });
  if (!formatPick) { return undefined; }

  // Workspace scope
  const scopeItems: Array<{ label: string; description: string; value: 'current' | 'all' | 'pick' }> = [
    { label: '$(folder-active) Current workspace only', description: 'Export conversations from the active workspace', value: 'current' },
    { label: '$(list-unordered) All workspaces', description: 'Export conversations from every workspace', value: 'all' },
    { label: '$(search) Pick a specific workspace...', description: 'Choose from a list of workspaces that have chat sessions', value: 'pick' }
  ];
  const scopePick = await vscode.window.showQuickPick(scopeItems, {
    placeHolder: 'Which workspaces to export?'
  });
  if (!scopePick) { return undefined; }

  // If user chose 'pick', show workspace chooser
  let pickedCandidates: WorkspaceCandidate[] | undefined;
  if (scopePick.value === 'pick') {
    const storagePaths = getVSCodeStoragePaths();
    const allCandidates: WorkspaceCandidate[] = [];
    for (const sp of storagePaths) {
      allCandidates.push(...collectWorkspaceCandidates(sp));
    }

    if (allCandidates.length === 0) {
      vscode.window.showWarningMessage('No workspaces with Copilot chat sessions found.');
      return undefined;
    }

    // Count requests per candidate for display
    const candidateItems = allCandidates.map(c => {
      const sessionCount = c.sessionFiles.length;
      const folderDisplay = c.workspaceFolderPath
        ? `${path.basename(c.workspaceFolderPath)} (${c.workspaceFolderPath})`
        : `[no path] hash: ${c.workspaceDir.substring(0, 8)}`;
      return {
        label: c.workspaceLabel ?? c.workspaceDir.substring(0, 12),
        description: `${sessionCount} session file(s)`,
        detail: folderDisplay,
        candidate: c
      };
    }).sort((a, b) => a.label.localeCompare(b.label));

    const selected = await vscode.window.showQuickPick(candidateItems, {
      placeHolder: 'Select workspace(s) to export (multi-select with spacebar)',
      canPickMany: true,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!selected || selected.length === 0) { return undefined; }
    pickedCandidates = selected.map(s => s.candidate);
  }

  // Date filter
  const defaultDaysBack = config.get<number>('defaultDaysBack', 0);
  const dateInput = await vscode.window.showInputBox({
    prompt: 'Filter: only export conversations from the last N days. Leave empty to export all.',
    placeHolder: defaultDaysBack > 0 ? String(defaultDaysBack) : 'e.g. 30 — or leave empty for all time',
    value: defaultDaysBack > 0 ? String(defaultDaysBack) : '',
    validateInput: (v) => {
      if (v.trim() === '') { return null; }
      const n = parseInt(v.trim(), 10);
      return (isNaN(n) || n <= 0) ? 'Enter a positive whole number, or leave empty for all time.' : null;
    }
  });
  if (dateInput === undefined) { return undefined; } // user pressed Escape

  let sinceDate: Date | null = null;
  if (dateInput.trim() !== '') {
    const days = parseInt(dateInput.trim(), 10);
    if (!isNaN(days) && days > 0) {
      sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }
  }

  return { format: formatPick.value, workspaceScope: scopePick.value, sinceDate, pickedCandidates };
}

export function activate(context: vscode.ExtensionContext) {
  // Status bar button
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(file-code) Export Copilot Chat";
  statusBarItem.command = 'copilot-exporter.exportWorkspaceHistory';
  statusBarItem.tooltip = "Export GitHub Copilot chat history";
  statusBarItem.show();

  const exportCommand = vscode.commands.registerCommand('copilot-exporter.exportWorkspaceHistory', async () => {
    try {
      // Prompt for export options (format, scope, date filter)
      const options = await promptExportOptions();
      if (!options) { return; } // user cancelled

      // Determine output directory
      const config = vscode.workspace.getConfiguration('copilotExporter');
      const configuredOutDir = config.get<string>('outputDirectory', '').trim();
      const folders = vscode.workspace.workspaceFolders || [];
      const defaultOut = configuredOutDir || (folders.length
        ? path.join(folders[0].uri.fsPath, 'copilot_exports')
        : path.join(os.homedir(), 'copilot_exports'));

      const outUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Select output folder',
        defaultUri: vscode.Uri.file(defaultOut)
      });

      const outDir = outUri ? outUri[0].fsPath : defaultOut;
      await mkdir(outDir, { recursive: true });

      const allEntries: CopilotEntry[] = [];
      const diagnostics: string[] = [];

      await scanChatSessionFiles(allEntries, diagnostics, options);

      if (allEntries.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFiles: string[] = [];

        if (options.format === 'json' || options.format === 'both') {
          const outputFile = path.join(outDir, `copilot_export_${timestamp}.json`);
          await writeFile(outputFile, JSON.stringify(allEntries, null, 2), 'utf8');
          outputFiles.push(outputFile);
        }

        if (options.format === 'markdown' || options.format === 'both') {
          const outputFile = path.join(outDir, `copilot_export_${timestamp}.md`);
          await writeFile(outputFile, entriesToMarkdown(allEntries), 'utf8');
          outputFiles.push(outputFile);
        }

        const message = `Export complete! ${allEntries.length} conversations exported.`;
        const action = await vscode.window.showInformationMessage(message, 'Open File', 'Open Folder');

        if (action === 'Open File') {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputFiles[0]));
        } else if (action === 'Open Folder') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outDir));
        }
      } else {
        // Create detailed diagnostic report
        const diagnosticReport = [
          '# Copilot Export Diagnostics',
          '',
          '## Search Details',
          ...diagnostics.map(d => `- ${d}`),
          '',
          '## Possible Solutions',
          '- Make sure you have used GitHub Copilot Chat in this workspace',
          '- Try opening a different workspace where you\'ve used Copilot',
          '- Check if VS Code is storing data in a custom location',
          '- On Windows, data might be in a different AppData folder',
          '- Verify workspace.json mapping if your workspace was moved or renamed'
        ].join('\n');

        const diagnosticFile = path.join(outDir, `copilot_export_diagnostics_${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        await writeFile(diagnosticFile, diagnosticReport, 'utf8');

        const action = await vscode.window.showWarningMessage(
          'No Copilot data found. Click "View Details" to see diagnostic information.',
          'View Details',
          'Close'
        );

        if (action === 'View Details') {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(diagnosticFile));
        }
      }

    } catch (error) {
      vscode.window.showErrorMessage('Copilot export failed: ' + String(error));
    }
  });

  context.subscriptions.push(statusBarItem, exportCommand);
}

export function deactivate() {}

