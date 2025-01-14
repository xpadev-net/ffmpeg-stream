import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import { createReadStream, createWriteStream, unlink } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import type { Readable, Writable } from "stream";
import { PassThrough } from "stream";
import { promisify } from "util";

const logger = pino();

const { FFMPEG_PATH = "ffmpeg" } = process.env;
const EXIT_CODES = [0, 255];

function debugStream(stream: Readable | Writable, name: string): void {
  stream.on("error", (err) => {
    logger.debug(`${name} error: ${err.message}`);
  });
  stream.on("data", (data: string | Buffer) => {
    logger.debug(`${name} data: ${data.length} bytes`);
  });
  stream.on("finish", () => {
    logger.debug(`${name} finish`);
  });
}

function getTmpPath(prefix = "", suffix = ""): string {
  const dir = tmpdir();
  const id = Math.random().toString(32).substr(2, 10);
  return join(dir, `${prefix}${id}${suffix}`);
}

type Options = Record<
  string,
  | string
  | number
  | boolean
  | Array<string | null | undefined>
  | null
  | undefined
>;

function getArgs(options: Options): string[] {
  const args: string[] = [];
  for (const option in options) {
    const value = options[option];
    if (Array.isArray(value)) {
      for (const element of value) {
        if (element != null) {
          args.push(`-${option}`);
          args.push(String(element));
        }
      }
    } else if (value != null && value !== false) {
      args.push(`-${option}`);
      if (typeof value != "boolean") {
        args.push(String(value));
      }
    }
  }
  return args;
}

interface Pipe {
  readonly type: "input" | "output";
  readonly options: Options;
  readonly file: string;
  onBegin?: (this: void) => Promise<void>;
  onSpawn?: (this: void, process: ChildProcess) => void;
  onFinish?: (this: void) => Promise<void>;
}

/** @deprecated Construct [[Converter]] class directly */
export function ffmpeg(): Converter {
  return new Converter();
}

export class Converter {
  private fdCount = 0;
  private readonly pipes: Pipe[] = [];
  private process?: ChildProcess;
  private killed = false;
  private readonly ffmpegPath: string;

  constructor(ffmpegPath: string = FFMPEG_PATH) {
    this.ffmpegPath = ffmpegPath;
  }

  /** @deprecated Use [[createInputStream]] or [[createInputFromFile]] */
  input(options?: Options): Writable;
  input(file: string, options?: Options): void;
  input(arg0?: string | Options, arg1?: Options): Writable | undefined {
    const [file, opts = {}] =
      typeof arg0 == "string" ? [arg0, arg1] : [undefined, arg0];

    if (file != null) {
      return void this.createInputFromFile(file, opts);
    }
    if (opts.buffer) {
      delete opts.buffer;
      return this.createBufferedInputStream(opts);
    }
    return this.createInputStream(opts);
  }

  /** @deprecated Use [[createOutputStream]] or [[createOutputToFile]] */
  output(options?: Options): Readable;
  output(file: string, options?: Options): void;
  output(arg0?: string | Options, arg1?: Options): Readable | undefined {
    const [file, opts = {}] =
      typeof arg0 == "string" ? [arg0, arg1] : [undefined, arg0];

    if (file != null) {
      return void this.createOutputToFile(file, opts);
    }
    if (opts.buffer) {
      delete opts.buffer;
      return this.createBufferedOutputStream(opts);
    }
    return this.createOutputStream(opts);
  }

  createInputFromFile(file: string, options: Options): void {
    this.pipes.push({
      type: "input",
      options,
      file,
    });
  }

  createOutputToFile(file: string, options: Options): void {
    this.pipes.push({
      type: "output",
      options,
      file,
    });
  }

  createInputStream(options: Options): Writable {
    const stream = new PassThrough();
    const fd = this.getUniqueFd();
    this.pipes.push({
      type: "input",
      options,
      file: `pipe:${fd}`,
      onSpawn: (process) => {
        const stdio = process.stdio[fd];
        if (stdio == null) throw Error(`input ${fd} is null`);
        debugStream(stream, `input ${fd}`);
        if (!("write" in stdio)) throw Error(`input ${fd} is not writable`);
        stream.pipe(stdio);
      },
    });

    return stream;
  }

  createOutputStream(options: Options): Readable {
    const stream = new PassThrough();
    const fd = this.getUniqueFd();
    this.pipes.push({
      type: "output",
      options,
      file: `pipe:${fd}`,
      onSpawn: (process) => {
        const stdio = process.stdio[fd];
        if (stdio == null) throw Error(`output ${fd} is null`);
        debugStream(stdio, `output ${fd}`);
        stdio.pipe(stream);
      },
    });
    return stream;
  }

  createBufferedInputStream(options: Options): Writable {
    const stream = new PassThrough();
    const file = getTmpPath("ffmpeg-");
    this.pipes.push({
      type: "input",
      options,
      file,
      onBegin: async () => {
        await new Promise<void>((resolve, reject): void => {
          const writer = createWriteStream(file);
          stream.pipe(writer);
          stream.on("end", () => {
            logger.debug("input buffered stream end");
            resolve();
          });
          stream.on("error", (err) => {
            logger.debug(`input buffered stream error: ${err.message}`);
            return reject(err);
          });
        });
      },
      onFinish: async () => {
        await promisify(unlink)(file);
      },
    });
    return stream;
  }

  createBufferedOutputStream(options: Options): Readable {
    const stream = new PassThrough();
    const file = getTmpPath("ffmpeg-");
    this.pipes.push({
      type: "output",
      options,
      file,
      onFinish: async () => {
        await new Promise<void>((resolve, reject): void => {
          const reader = createReadStream(file);
          reader.pipe(stream);
          reader.on("end", () => {
            logger.debug("output buffered stream end");
            resolve();
          });
          reader.on("error", (err: Error) => {
            logger.debug(`output buffered stream error: ${err.message}`);
            reject(err);
          });
        });
        await promisify(unlink)(file);
      },
    });
    return stream;
  }

  async run(): Promise<void> {
    const pipes: Pipe[] = [];
    try {
      for (const pipe of this.pipes) {
        logger.debug(`prepare ${pipe.type}`);
        await pipe.onBegin?.();
        pipes.push(pipe);
      }

      const command = this.getSpawnArgs();
      const stdio = this.getStdioArg();
      logger.debug(`spawn: ${this.ffmpegPath} ${command.join(" ")}`);
      logger.debug(`spawn stdio: ${stdio.join(" ")}`);
      this.process = spawn(this.ffmpegPath, command, { stdio });
      const finished = this.handleProcess();

      for (const pipe of this.pipes) {
        pipe.onSpawn?.(this.process);
      }

      if (this.killed) {
        // the converter was already killed so stop it immediately
        this.process.kill("SIGKILL");
      }

      await finished;
    } finally {
      for (const pipe of pipes) {
        await pipe.onFinish?.();
      }
    }
  }

  stop(): void {
    this.process?.kill("SIGINT");
  }

  kill(): void {
    // kill the process if it already started
    this.process?.kill();
    // set the flag so it will be killed after it's initialized
    this.killed = true;
  }

  private getUniqueFd(): number {
    return this.fdCount++ + 3;
  }

  private getStdioArg(): Array<"ignore" | "pipe"> {
    return [
      "ignore",
      "ignore",
      "pipe",
      ...Array<"pipe">(this.fdCount).fill("pipe"),
    ];
  }

  private getSpawnArgs(): string[] {
    const command: string[] = [];

    for (const pipe of this.pipes) {
      if (pipe.type !== "input") continue;
      command.push(...getArgs(pipe.options));
      command.push("-i", pipe.file);
    }
    for (const pipe of this.pipes) {
      if (pipe.type !== "output") continue;
      command.push(...getArgs(pipe.options));
      command.push(pipe.file);
    }

    return command;
  }

  private async handleProcess(): Promise<void> {
    await new Promise<void>((resolve, reject): void => {
      let logSectionNum = 0;
      const logLines: string[] = [];

      if (this.process == null) return reject(Error(`Converter not started`));

      if (this.process.stderr != null) {
        this.process.stderr.setEncoding("utf8");

        this.process.stderr.on("data", (data: string) => {
          const lines = data.split(/\r\n|\r|\n/u);
          for (const line of lines) {
            // skip empty lines
            if (/^\s*$/u.exec(line) != null) continue;
            // if not indented: increment section counter
            if (/^\s/u.exec(line) == null) logSectionNum++;
            // only log sections following the first one
            if (logSectionNum > 1) {
              logger.debug(`log: ${line}`);
              logLines.push(line);
            }
          }
        });
      }

      this.process.on("error", (err) => {
        logger.debug(`error: ${err.message}`);
        return reject(err);
      });

      this.process.on("exit", (code, signal) => {
        logger.debug(
          `exit: code=${code ?? "unknown"} sig=${signal ?? "unknown"}`,
        );
        if (code == null) return resolve();
        if (EXIT_CODES.includes(code)) return resolve();
        const log = logLines.map((line) => `  ${line}`).join("\n");
        reject(Error(`Converting failed\n${log}`));
      });
    });
  }
}
