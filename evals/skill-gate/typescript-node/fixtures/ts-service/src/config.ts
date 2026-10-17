export interface Config {
  host: string;
  port: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return { host: env.HOST ?? "127.0.0.1", port: Number(env.PORT ?? "8080") };
}
