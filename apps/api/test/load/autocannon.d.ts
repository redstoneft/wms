// Minimal typing for autocannon (no official types shipped for v8 in this setup).
declare module 'autocannon' {
  namespace autocannon {
    interface Options {
      url: string;
      connections?: number;
      duration?: number;
      amount?: number;
      headers?: Record<string, string>;
      requests?: { method?: string; path?: string; body?: string; setupRequest?: (req: any) => any }[];
    }
    interface Result {
      requests: { average: number };
      latency: { p50: number; p99: number };
      non2xx: number;
      errors: number;
    }
  }
  function autocannon(opts: autocannon.Options, cb: (err: Error | null, res: autocannon.Result) => void): void;
  export = autocannon;
}
