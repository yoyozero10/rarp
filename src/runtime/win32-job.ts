import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Win32Job {
  readonly pid: number;
  readonly ready: Promise<boolean>;
  terminate: () => void;
  dispose: () => void;
}

type LauncherTarget =
  | { type: "exe"; path: string }
  | { type: "ps1"; path: string };

const CSHARP_LAUNCHER_SOURCE = `using System;
using System.IO;
using System.Runtime.InteropServices;

namespace Rarp.Runtime {
    static class Win32JobLauncher {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryLimit;
            public UIntPtr PeakJobMemoryLimit;
        }

        const int JobObjectExtendedLimitInformation = 9;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        const uint PROCESS_ALL_ACCESS = 0x1FFFFF;
        const uint PROCESS_SET_QUOTA = 0x0100;
        const uint PROCESS_TERMINATE = 0x0001;

        static int Main(string[] args) {
            if (args.Length < 1) {
                Console.Error.WriteLine("Missing PID argument");
                return 1;
            }

            int targetPid;
            if (!int.TryParse(args[0], out targetPid)) {
                Console.Error.WriteLine("Invalid PID");
                return 1;
            }

            IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero) {
                Console.Error.WriteLine("Failed to create Job Object");
                return 2;
            }

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pInfo = Marshal.AllocHGlobal(length);
            try {
                Marshal.StructureToPtr(info, pInfo, false);
                if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, pInfo, (uint)length)) {
                    CloseHandle(hJob);
                    Console.Error.WriteLine("Failed to set Job Object info");
                    return 3;
                }
            } finally {
                Marshal.FreeHGlobal(pInfo);
            }

            IntPtr hProcess = OpenProcess(PROCESS_ALL_ACCESS, false, targetPid);
            if (hProcess == IntPtr.Zero) {
                hProcess = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, targetPid);
            }
            if (hProcess == IntPtr.Zero) {
                CloseHandle(hJob);
                Console.Error.WriteLine("Failed to open process " + targetPid);
                return 4;
            }

            try {
                if (!AssignProcessToJobObject(hJob, hProcess)) {
                    CloseHandle(hJob);
                    Console.Error.WriteLine("Failed to assign process " + targetPid + " to job");
                    return 5;
                }
            } finally {
                CloseHandle(hProcess);
            }

            Console.WriteLine("JOB_READY");
            Console.Out.Flush();

            string line;
            while ((line = Console.ReadLine()) != null) {
                string cmd = line.Trim();
                if (cmd == "terminate") {
                    TerminateJobObject(hJob, 1);
                    break;
                }
                if (cmd == "close" || cmd == "exit") {
                    break;
                }
            }

            CloseHandle(hJob);
            return 0;
        }
    }
}
`;

const POWERSHELL_LAUNCHER_SOURCE = `param([int]$targetPid)

$src = @"
using System;
using System.Runtime.InteropServices;

public static class RarpJobApi {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryLimit;
        public UIntPtr PeakJobMemoryLimit;
    }

    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint PROCESS_ALL_ACCESS = 0x1FFFFF;
    public const uint PROCESS_SET_QUOTA = 0x0100;
    public const uint PROCESS_TERMINATE = 0x0001;

    public static IntPtr CreateJobWithKillOnClose() {
        IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) return IntPtr.Zero;

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pInfo = Marshal.AllocHGlobal(length);
        try {
            Marshal.StructureToPtr(info, pInfo, false);
            if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, pInfo, (uint)length)) {
                CloseHandle(hJob);
                return IntPtr.Zero;
            }
        } finally {
            Marshal.FreeHGlobal(pInfo);
        }
        return hJob;
    }

    public static bool AssignPid(IntPtr hJob, int pid) {
        IntPtr hProcess = OpenProcess(PROCESS_ALL_ACCESS, false, pid);
        if (hProcess == IntPtr.Zero) {
            hProcess = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
        }
        if (hProcess == IntPtr.Zero) return false;
        try {
            return AssignProcessToJobObject(hJob, hProcess);
        } finally {
            CloseHandle(hProcess);
        }
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'RarpJobApi').Type) {
    Add-Type -TypeDefinition $src
}

$hJob = [RarpJobApi]::CreateJobWithKillOnClose()
if ($hJob -eq [IntPtr]::Zero) {
    exit 2
}

if (-not [RarpJobApi]::AssignPid($hJob, $targetPid)) {
    [RarpJobApi]::CloseHandle($hJob)
    exit 3
}

[Console]::Out.WriteLine("JOB_READY")
[Console]::Out.Flush()

try {
    while ($line = [Console]::In.ReadLine()) {
        $cmd = $line.Trim()
        if ($cmd -eq "terminate") {
            [RarpJobApi]::TerminateJobObject($hJob, 1)
            break
        }
        if ($cmd -eq "close" -or $cmd -eq "exit") {
            break
        }
    }
} finally {
    [RarpJobApi]::CloseHandle($hJob)
}
`;

function findCsc(): string | undefined {
  const root =
    process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [
    resolve(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    resolve(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

let cachedLauncher: LauncherTarget | null | undefined;

function getLauncher(): LauncherTarget | null {
  if (cachedLauncher !== undefined) return cachedLauncher;
  if (process.platform !== "win32") {
    cachedLauncher = null;
    return null;
  }

  const exePath = join(tmpdir(), "rarp-win32-job-v1.exe");
  if (existsSync(exePath)) {
    cachedLauncher = { type: "exe", path: exePath };
    return cachedLauncher;
  }

  const csc = findCsc();
  if (csc) {
    try {
      const srcPath = join(tmpdir(), "rarp-win32-job-v1.cs");
      writeFileSync(srcPath, CSHARP_LAUNCHER_SOURCE, "utf8");
      const res = spawnSync(
        csc,
        ["/nologo", "/optimize", "/target:exe", `/out:${exePath}`, srcPath],
        { windowsHide: true, timeout: 10000 },
      );
      if (res.status === 0 && existsSync(exePath)) {
        cachedLauncher = { type: "exe", path: exePath };
        return cachedLauncher;
      }
    } catch {
      // Fall through to PowerShell script
    }
  }

  // Fallback to PowerShell script
  try {
    const ps1Path = join(tmpdir(), "rarp-win32-job-v1.ps1");
    if (!existsSync(ps1Path)) {
      writeFileSync(ps1Path, POWERSHELL_LAUNCHER_SOURCE, "utf8");
    }
    cachedLauncher = { type: "ps1", path: ps1Path };
    return cachedLauncher;
  } catch {
    cachedLauncher = null;
    return null;
  }
}

export function isContainmentAvailable(): boolean {
  if (process.platform !== "win32") return false;
  return Boolean(getLauncher());
}

export function createJobContainer(pid: number): Win32Job | undefined {
  if (process.platform !== "win32") return undefined;
  const launcher = getLauncher();
  if (!launcher) return undefined;

  let child: ChildProcess;
  try {
    if (launcher.type === "exe") {
      child = spawn(launcher.path, [String(pid)], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } else {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          launcher.path,
          String(pid),
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
    }
  } catch {
    return undefined;
  }

  let resolved = false;
  let timer: NodeJS.Timeout | undefined;

  const ready = new Promise<boolean>((resolve) => {
    const onReady = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    timer = setTimeout(() => {
      onReady(false);
    }, 1500);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (chunk.toString().includes("JOB_READY")) {
        onReady(true);
      }
    });

    child.on("error", () => onReady(false));
    child.on("exit", () => onReady(false));
  });

  const sendCommand = (cmd: string) => {
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(cmd + "\n");
        child.stdin.end();
      }
    } catch {
      // Ignore
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore
      }
    }, 200).unref();
  };

  return {
    pid,
    ready,
    terminate: () => sendCommand("terminate"),
    dispose: () => sendCommand("close"),
  };
}
