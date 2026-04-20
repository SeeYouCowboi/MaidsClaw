import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";

const BASE_TALKER_THINKER = {
	enabled: false,
	stalenessThreshold: 2,
	softBlockTimeoutMs: 3000,
	softBlockPollIntervalMs: 500,
} as const;

describe("bootstrapRuntime talkerThinker rollout matrix", () => {
	it("omitted rollout flags resolve to post-cleanup defaults", () => {
		const runtime = bootstrapRuntime({
			runtimeConfig: {
				talkerThinker: { ...BASE_TALKER_THINKER },
			},
		});

		try {
			expect(runtime.talkerThinkerConfig.speakerNormalizationGate).toBe(true);
			expect(runtime.talkerThinkerConfig.sceneFactWritePath).toBe(true);
			expect(runtime.talkerThinkerConfig.sceneRetrieval).toBe(true);
			expect(runtime.talkerThinkerConfig.legacyAreaStateCompat).toBe(false);

			expect(
				runtime.runtimeConfigSnapshot.talkerThinker?.speakerNormalizationGate,
			).toBe(true);
			expect(runtime.runtimeConfigSnapshot.talkerThinker?.sceneFactWritePath).toBe(
				true,
			);
			expect(runtime.runtimeConfigSnapshot.talkerThinker?.sceneRetrieval).toBe(
				true,
			);
			expect(
				runtime.runtimeConfigSnapshot.talkerThinker?.legacyAreaStateCompat,
			).toBe(false);
		} finally {
			runtime.shutdown();
		}
	});

	it("post-cleanup approved matrices bootstrap successfully", () => {
		const approved = [
			{
				name: "final-default",
				speakerNormalizationGate: true,
				sceneFactWritePath: true,
				sceneRetrieval: true,
				legacyAreaStateCompat: false,
			},
			{
				name: "read-path-rollback",
				speakerNormalizationGate: true,
				sceneFactWritePath: true,
				sceneRetrieval: false,
				legacyAreaStateCompat: false,
			},
		] as const;

		for (const matrix of approved) {
			const runtime = bootstrapRuntime({
				runtimeConfig: {
					talkerThinker: {
						...BASE_TALKER_THINKER,
						speakerNormalizationGate: matrix.speakerNormalizationGate,
						sceneFactWritePath: matrix.sceneFactWritePath,
						sceneRetrieval: matrix.sceneRetrieval,
						legacyAreaStateCompat: matrix.legacyAreaStateCompat,
					},
				},
			});

			try {
				expect(runtime.talkerThinkerConfig.speakerNormalizationGate).toBe(
					matrix.speakerNormalizationGate,
				);
				expect(runtime.talkerThinkerConfig.sceneFactWritePath).toBe(
					matrix.sceneFactWritePath,
				);
				expect(runtime.talkerThinkerConfig.sceneRetrieval).toBe(
					matrix.sceneRetrieval,
				);
				expect(runtime.talkerThinkerConfig.legacyAreaStateCompat).toBe(
					matrix.legacyAreaStateCompat,
				);
			} finally {
				runtime.shutdown();
			}
		}
	});

	it("(true,true,true,false) passes — final default", () => {
		const runtime = bootstrapRuntime({
			runtimeConfig: {
				talkerThinker: {
					...BASE_TALKER_THINKER,
					speakerNormalizationGate: true,
					sceneFactWritePath: true,
					sceneRetrieval: true,
					legacyAreaStateCompat: false,
				},
			},
		});

		try {
			expect(runtime.talkerThinkerConfig.legacyAreaStateCompat).toBe(false);
		} finally {
			runtime.shutdown();
		}
	});

	it("(true,true,false,false) passes — read-path rollback", () => {
		const runtime = bootstrapRuntime({
			runtimeConfig: {
				talkerThinker: {
					...BASE_TALKER_THINKER,
					speakerNormalizationGate: true,
					sceneFactWritePath: true,
					sceneRetrieval: false,
					legacyAreaStateCompat: false,
				},
			},
		});

		try {
			expect(runtime.talkerThinkerConfig.sceneRetrieval).toBe(false);
			expect(runtime.talkerThinkerConfig.legacyAreaStateCompat).toBe(false);
		} finally {
			runtime.shutdown();
		}
	});

	it("(true,true,true,true) NOW fails — legacyAreaStateCompat=true rejected", () => {
		expect(() =>
			bootstrapRuntime({
				runtimeConfig: {
					talkerThinker: {
						...BASE_TALKER_THINKER,
						speakerNormalizationGate: true,
						sceneFactWritePath: true,
						sceneRetrieval: true,
						legacyAreaStateCompat: true,
					},
				},
			}),
		).toThrow(
			"[bootstrapRuntime] Unsupported talkerThinker rollout matrix after cleanup:",
		);
	});

	it("(true,false,false,true) NOW fails — both sceneFactWritePath=false and legacyAreaStateCompat=true", () => {
		expect(() =>
			bootstrapRuntime({
				runtimeConfig: {
					talkerThinker: {
						...BASE_TALKER_THINKER,
						speakerNormalizationGate: true,
						sceneFactWritePath: false,
						sceneRetrieval: false,
						legacyAreaStateCompat: true,
					},
				},
			}),
		).toThrow(
			"[bootstrapRuntime] Unsupported talkerThinker rollout matrix after cleanup:",
		);
	});

	it("illegal matrices fail bootstrap with deterministic error", () => {
		const illegal = [
			{
				matrix: {
					speakerNormalizationGate: false,
					sceneFactWritePath: false,
					sceneRetrieval: false,
					legacyAreaStateCompat: false,
				},
				errorMatrix:
					"(speakerNormalizationGate=false,sceneFactWritePath=false,sceneRetrieval=false,legacyAreaStateCompat=false)",
			},
			{
				matrix: {
					speakerNormalizationGate: false,
					sceneFactWritePath: true,
					sceneRetrieval: true,
					legacyAreaStateCompat: false,
				},
				errorMatrix:
					"(speakerNormalizationGate=false,sceneFactWritePath=true,sceneRetrieval=true,legacyAreaStateCompat=false)",
			},
			{
				matrix: {
					speakerNormalizationGate: true,
					sceneFactWritePath: false,
					sceneRetrieval: false,
					legacyAreaStateCompat: false,
				},
				errorMatrix:
					"(speakerNormalizationGate=true,sceneFactWritePath=false,sceneRetrieval=false,legacyAreaStateCompat=false)",
			},
		] as const;

		for (const sample of illegal) {
			expect(() =>
				bootstrapRuntime({
					runtimeConfig: {
						talkerThinker: {
							...BASE_TALKER_THINKER,
							...sample.matrix,
						},
					},
				}),
			).toThrow(
				`[bootstrapRuntime] Unsupported talkerThinker rollout matrix after cleanup: ${sample.errorMatrix}. Allowed matrices:`,
			);
		}
	});
});
