import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execSync } from "child_process";
import process from "node:process";
import fs from "fs";
import path from "path";

/**
 * MCP Server: mcp-server-shell
 * This server allows arbitrary shell execution via systemd-run.
 * Each command is isolated in its own transient systemd unit,
 * with logs managed via systemd's RuntimeDirectory for automatic cleanup.
 */

const RUN_ID = process.env.RUN_ID || Math.random().toString(36).substring(2, 10);
const MAIN_UNIT = `mcp-server-shell-${RUN_ID}`;
const LOG_DIR = process.env.RUNTIME_DIRECTORY

function main() {
  // --- Self-Bootstrap into Systemd ---
  if (!process.env.INVOCATION_ID) {
    const command = "/usr/bin/systemd-run";
    const args = [
      "systemd-run",
      "--user",
      "--quiet",
      "--wait",
      "--pipe",
      `--unit=${MAIN_UNIT}`,
      "-p", `RuntimeDirectory=mcp-server-shell-${RUN_ID}`,
      "-p", `Environment=RUN_ID=${RUN_ID}`,
      "--",
      ...process.argv,
    ];

    try {
      process.execve(command, args);
    } catch (err) {
      console.error(`Failed to execve into systemd-run: ${err.message}`);
      process.exit(1);
    }
  } else {
    startServer();
  }
}

// --- Common Schemas ---

const StateSchema = z.object({
  status: z.enum(["RUNNING", "SIGNALED", "EXITED", "ERRORED"]),
  code: z.number().optional().describe('The exit status code (populated only when the status is EXITED)'),
  signal: z.string().optional().describe('The signal that terminated the process (populated only when the status is SIGNALED)'),
  message: z.string().optional().describe('Additional error messages (populated only when the status is ERRORED)'),
}).describe('State of the shell script execution')

const ShellResultSchema = z.object({
  shellId: z.string().describe('A random ID assigned to the shell'),
  stdout: z.string().describe('What the script has written to stdout so far (could be partial if the script is still running; guaranteed to be complete if has finished)'),
  stderr: z.string().describe('What the script has written to stderr so far (could be partial if the script is still running; guaranteed to be complete if has finished)'),
  state: StateSchema,
})

// --- Helper Functions ---

const getLogPaths = (shellId) => ({
  stdout: path.join(LOG_DIR, `${shellId}.out`),
  stderr: path.join(LOG_DIR, `${shellId}.err`),
  result: path.join(LOG_DIR, `${shellId}.result`),
});

const readLogs = (shell) => {
  let stdout = "";
  let stderr = "";
  if (fs.existsSync(shell.stdout)) {
    const fdOut = fs.openSync(shell.stdout, 'r');
    fs.fdatasyncSync(fdOut);
    stdout = fs.readFileSync(fdOut, 'utf8');
    fs.closeSync(fdOut);
  }
  if (fs.existsSync(shell.stderr)) {
    const fdErr = fs.openSync(shell.stderr, 'r');
    fs.fdatasyncSync(fdErr);
    stderr = fs.readFileSync(fdErr, 'utf8');
    fs.closeSync(fdErr);
  }
  return { stdout, stderr };
};

const getShellResult = (shell) => {
  const { shellId, state } = shell
  const { stdout, stderr } = readLogs(shell);
  return { shellId, state, stdout, stderr };
};

function wrapToolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result
  };
}

async function startServer() {
  if (!LOG_DIR)
    throw Error('LOG_DIR not set')

  const server = new McpServer({
    name: "mcp-server-shell",
    version: "1.0.0",
  });

  const shells = new Map();

  // --- Tool Registrations ---

  server.registerTool(
    "run_shell",
    {
      description: "Run script as shell script via systemd-run. Returns as soon as the script finishes or after 3s.",
      inputSchema: {
        script: z.string().describe("The shell script to execute"),
        cwd: z.string().optional().describe("The current working directory of the shell"),
        background: z.boolean().optional().describe("If true, returns immediately without waiting for completion for 3 seconds. Useful to eliminate unnecessary delays when you are running a background process that are not expected to finish within a couple of seconds"),
      },
      outputSchema: ShellResultSchema
    },
    async ({ script, cwd, background }) => {
      const shellId = Math.random().toString(36).substring(2, 10);
      const unit = `${MAIN_UNIT}-${shellId}`;
      const { stdout, stderr, result } = getLogPaths(shellId);

      const systemdArgs = [
        "--user",
        "--quiet",
        "--wait",
        "-u", unit,
        ...(cwd ? ["-p", `WorkingDirectory=${cwd}`] : []),
        "-p", `StandardOutput=append:${stdout}`,
        "-p", `StandardError=append:${stderr}`,
        "-p", `Environment=RESULT_PATH=${result}`,
        "-p", `BindsTo=${MAIN_UNIT}.service`,
        "-p", `After=${MAIN_UNIT}.service`,
        "-p", 'ExecStopPost=/bin/sh -c "jq --arg code \\"$EXIT_CODE\\" --arg status \\"$EXIT_STATUS\\" -nc \'{ code: $code, status: $status }\' >\\"$RESULT_PATH\\" 2>&1"',
        "-p", "TimeoutStopSec=3",
        "-p", "CollectMode=inactive-or-failed",
        "--",
        "/bin/bash", "-c", script
      ];

      const child = spawn("systemd-run", systemdArgs);
      const completionPromise = new Promise((resolve) => {
        child.on("exit", () => {
          try {
            const fd = fs.openSync(result, 'r')
            try {
              const resultContent = fs.readFileSync(result, 'utf8')
              const { code, status } = JSON.parse(resultContent)
              if (code === 'exited') {
                shells.get(shellId).state = {
                  status: 'EXITED',
                  code: parseInt(status),
                }
              } else {
                shells.get(shellId).state = {
                  status: 'SIGNALED',
                  signal: status,
                }
              }
            } finally {
              fs.closeSync(fd)
            }
          } catch (e) {
            console.error('Failed to read result', e);
            shells.get(shellId).state = {
              status: 'ERRORED',
              message: 'Failed to read result',
            }
          }
          resolve()
        });
        child.on("error", (err) => {
          console.error('spawn error', err)
          shells.get(shellId).state = {
            status: 'ERRORED',
            message: err.message
          }
          resolve()
        });
      })
      const shell = {
        shellId,
        unit,
        script,
        state: { status: 'RUNNING' },
        completionPromise,
        stdout,
        stderr,
        result,
      }
      shells.set(shellId, shell);

      if (!background) {
        await Promise.race([
          completionPromise,
          new Promise((resolve) => setTimeout(() => resolve(), 3000))
        ]);
      }

      return wrapToolResult(getShellResult(shell));
    }
  );

  server.registerTool(
    "check_shell",
    {
      description: "Return the status and output of the script with the given shell ID.",
      inputSchema: {
        shellId: z.string().describe("The ID of the shell to check")
      },
      outputSchema: ShellResultSchema
    },
    async ({ shellId }) => {
      const shell = shells.get(shellId)
      if (!shell) return { isError: true, content: [{ type: "text", text: `Shell ID ${shellId} not found` }] };
      return wrapToolResult(getShellResult(shell));
    }
  );

  server.registerTool(
    "kill_shell",
    {
      description: "Terminate the command associated to the shell ID using systemctl stop.",
      inputSchema: {
        shellId: z.string().describe("The ID of the shell to terminate")
      },
      outputSchema: ShellResultSchema
    },
    async ({ shellId }) => {
      const shell = shells.get(shellId);
      if (!shell) return { isError: true, content: [{ type: "text", text: `Shell ID ${shellId} not found` }] };

      try {
        execSync(`systemctl --user stop ${shell.unit}`);
      } catch (e) {
        // Unit might already be stopped
        console.warn(`Failed to stop ${shell.unit}`, e);
      }

      await shell.completionPromise

      return wrapToolResult(getShellResult(shell));
    }
  );

  server.registerTool(
    "list_shell",
    {
      description: "List the shell IDs, associated scripts and their current statuses.",
      outputSchema: z.object({
        shells: z.array(z.object({
          shellId: z.string(),
          script: z.string(),
          state: StateSchema
        }))
      })
    },
    async () => {
      const list = Array.from(shells.values().map(({ shellId, script, state }) => ({ shellId, script, state })))
      return wrapToolResult({ shells: list });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main()
