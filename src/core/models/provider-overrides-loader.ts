import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ProviderCatalogEntry } from "./provider-types.js";

const modelSchema = z.object({
	id: z.string().min(1, "model.id is required"),
	displayName: z.string().min(1, "model.displayName is required"),
	contextWindow: z
		.number()
		.int("model.contextWindow must be an integer")
		.nonnegative("model.contextWindow must be >= 0"),
	maxOutputTokens: z
		.number()
		.int("model.maxOutputTokens must be an integer")
		.nonnegative("model.maxOutputTokens must be >= 0"),
	supportsTools: z.boolean(),
	supportsVision: z.boolean(),
	supportsEmbedding: z.boolean(),
});

const providerSchema = z.object({
	id: z.string().min(1, "provider.id is required"),
	displayName: z.string().min(1, "provider.displayName is required"),
	transportFamily: z.enum(["openai-compatible", "anthropic-native"]),
	apiKind: z.enum(["openai", "anthropic"]),
	riskTier: z.enum(["stable", "compatible", "experimental"]),
	baseUrl: z.string().url("provider.baseUrl must be a valid URL"),
	authModes: z.array(z.enum(["api-key", "oauth-token", "setup-token"]))
		.min(1, "provider.authModes must contain at least one auth mode"),
	selectionPolicy: z.object({
		enabledByDefault: z.boolean(),
		eligibleForAutoFallback: z.boolean(),
		isAutoDefault: z.boolean(),
	}),
	defaultChatModelId: z.string().min(1).optional(),
	defaultEmbeddingModelId: z.string().min(1).optional(),
	models: z.array(modelSchema).min(1, "provider.models must contain at least one model"),
	warningMessage: z.string().min(1).optional(),
	supportsStreamingUsage: z.boolean().optional(),
	extraHeaders: z.record(z.string(), z.string()).optional(),
	disableToolChoiceRequired: z.boolean().optional(),
	embeddingDimensions: z.number().int().positive().optional(),
});

const providerOverridesFileSchema = z.object({
	providers: z.array(providerSchema),
});

export type ProviderOverridesLoaderOptions = {
	cwd?: string;
	providersFilePath?: string;
};

function formatZodIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "root";
			return `${path}: ${issue.message}`;
		})
		.join("; ");
}

function resolveProvidersPath(options?: ProviderOverridesLoaderOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	if (options?.providersFilePath) {
		return isAbsolute(options.providersFilePath)
			? options.providersFilePath
			: resolve(cwd, options.providersFilePath);
	}
	return join(cwd, "config", "providers.json");
}

export function loadProviderOverrides(
	options?: ProviderOverridesLoaderOptions,
): ProviderCatalogEntry[] {
	const filePath = resolveProvidersPath(options);
	if (!existsSync(filePath)) {
		return [];
	}

	let parsed: unknown;
	try {
		const content = readFileSync(filePath, "utf-8");
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(
			`Invalid provider overrides JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const validated = providerOverridesFileSchema.safeParse(parsed);
	if (!validated.success) {
		throw new Error(
			`Invalid provider overrides config at ${filePath}: ${formatZodIssues(validated.error)}`,
		);
	}

	return validated.data.providers;
}
