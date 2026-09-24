import type {
  TransformLitsxOptions,
  TransformLitsxResult,
} from "@litsx/compiler";

export type EvolitMode = "development" | "production";
export type EvolitLitsxTarget = "server" | "client";

export type EvolitLitsxCompilerOptions = Omit<
  TransformLitsxOptions,
  "filename" | "ssr" | "reactCompat"
> & {
  /** Evolit always uses native LitSX lowering. */
  reactCompat?: false;
};

export type EvolitLitsxOutput = {
  id: string;
  kind: "asset" | "module" | "style";
  content: string | Uint8Array;
  specifier?: string;
  document?: boolean;
};

export type EvolitLitsxContribution = Partial<TransformLitsxResult> & {
  dependencies?: string[];
  outputs?: EvolitLitsxOutput[];
};

export type EvolitLitsxIntegrationContext = {
  readonly projectRoot: string;
  readonly mode: EvolitMode;
  readonly identity: Readonly<{ id: string }>;
};

export type EvolitLitsxModuleContext = {
  readonly sourcePath: string;
  readonly source: string;
  readonly target: EvolitLitsxTarget;
  readonly ssr: boolean;
  readonly sourceMaps: boolean;
  readonly generation: number;
  readonly result: TransformLitsxResult;
};

export type EvolitLitsxIntegrationInstance = {
  compiler?: EvolitLitsxCompilerOptions | ((context: {
    filename: string;
    ssr: boolean;
    sourceMaps: boolean;
    mode: EvolitMode;
  }) => EvolitLitsxCompilerOptions);
  resolveModule?(context: Readonly<{
    specifier: string;
    importer: string;
    target: EvolitLitsxTarget;
    ssr: boolean;
    sourceMaps: boolean;
    generation: number;
    mode: EvolitMode;
  }>): null | void | {
    code: string;
    map?: unknown;
    dependencies?: string[];
  } | Promise<null | void | {
    code: string;
    map?: unknown;
    dependencies?: string[];
  }>;
  processModule?(context: EvolitLitsxModuleContext): EvolitLitsxContribution | void | Promise<EvolitLitsxContribution | void>;
  finalize?(context: Readonly<Record<string, unknown> & {
    generation: number;
    mode: EvolitMode;
  }>): EvolitLitsxContribution | void | Promise<EvolitLitsxContribution | void>;
  invalidate?(context: Readonly<{
    paths: string[] | null;
    affected: boolean;
    generation: number;
    mode: EvolitMode;
  }>): void | Promise<void>;
  forget?(context: Readonly<{
    moduleId: string;
    generation: number;
    mode: EvolitMode;
  }>): void | Promise<void>;
  dispose?(): void | Promise<void>;
};

export type EvolitLitsxIntegration = {
  readonly name: string;
  create(context: EvolitLitsxIntegrationContext): EvolitLitsxIntegrationInstance | Promise<EvolitLitsxIntegrationInstance>;
};

export type EvolitLitsxConfig = {
  compiler?: EvolitLitsxCompilerOptions;
  integrations?: EvolitLitsxIntegration[];
};

export type EvolitConfig = {
  litsx?: EvolitLitsxConfig;
  [key: string]: unknown;
};

export type EvolitLitsxPipeline = {
  readonly identity: Readonly<{ id: string }>;
  readonly generation: number;
  readonly dependencies: string[];
  getCompilerOptions(context: { filename: string; ssr: boolean; sourceMaps: boolean }): TransformLitsxOptions;
  resolveModule(specifier: string, context: {
    importer: string;
    target: EvolitLitsxTarget;
    ssr: boolean;
    sourceMaps: boolean;
  }): Promise<string | null>;
  registerResolvedModule(specifier: string, sourcePath: string, outputPath: string): void;
  processModule(result: TransformLitsxResult, context: Omit<EvolitLitsxModuleContext, "result" | "generation">): Promise<TransformLitsxResult & { evolitDependencies: string[] }>;
  finalize(context?: Record<string, unknown>): Promise<null | {
    assets: Array<{ integration: string; id: string; kind: string; outputPath: string; hash: string; size: number }>;
    documentStyles: Array<{ integration: string; id: string; kind: string; outputPath: string; hash: string; size: number }>;
  }>;
  invalidate(changedPaths?: string[] | null): Promise<boolean>;
  forget(moduleId: string): Promise<void>;
  dispose(): Promise<void>;
};

export function createLitsxPipeline(options: {
  projectRoot: string;
  mode: EvolitMode;
  config?: EvolitConfig;
}): Promise<EvolitLitsxPipeline | null>;

export function defineEvolitConfig<T extends EvolitConfig>(config: T): T;
export function defineLitsxIntegration<T extends EvolitLitsxIntegration>(integration: T): T;
export function mergeLitsxAssetsIntoManifest<T extends Record<string, unknown>>(
  manifest: T,
  integrationManifest: Awaited<ReturnType<EvolitLitsxPipeline["finalize"]>>,
): T;
