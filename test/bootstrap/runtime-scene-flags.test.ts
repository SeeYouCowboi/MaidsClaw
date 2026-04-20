import { describe, expect, it } from "bun:test";
import { bootstrapRuntime } from "../../src/bootstrap/runtime.js";

const BASE_TALKER_THINKER = {
	enabled: false,
	stalenessThreshold: 2,
	softBlockTimeoutMs: 3000,
	softBlockPollIntervalMs: 500,
} as const;

describe("bootstrapRuntime talkerThinker rollout matrix", () => {
	it("omitted rollout flags resolve to foundation defaults", () => {
		const runtime = bootstrapRuntime({
			runtimeConfig: {
				talkerThinker: { ...BASE_TALKER_THINKER },
			},
		});

		try {
			expect(runtime.talkerThinkerConfig.speakerNormalizationGate).toBe(true);
			expect(runtime.talkerThinkerConfig.sceneFactWritePath).toBe(false);
			expect(runtime.talkerThinkerConfig.sceneRetrieval).toBe(false);
			expect(runtime.talkerThinkerConfig.legacyAreaStateCompat).toBe(true);

			expect(
				runtime.runtimeConfigSnapshot.talkerThinker?.speakerNormalizationGate,
			).toBe(true);
			expect(runtime.runtimeConfigSnapshot.talkerThinker?.sceneFactWritePath).toBe(
				false,
			);
			expect(runtime.runtimeConfigSnapshot.talkerThinker?.sceneRetrieval).toBe(
				false,
			);
			expect(
				runtime.runtimeConfigSnapshot.talkerThinker?.legacyAreaStateCompat,
			).toBe(true);
		} finally {
			runtime.shutdown();
		}
	});

	it("all approved matrices bootstrap successfully", () => {
		const approved = [
			{
				name: "foundation",
				speakerNormalizationGate: true,
				sceneFactWritePath: false,
				sceneRetrieval: false,
				legacyAreaStateCompat: true,
			},
			{
				name: "writer-bake",
				speakerNormalizationGate: true,
				sceneFactWritePath: true,
				sceneRetrieval: false,
				legacyAreaStateCompat: true,
			},
			{
				name: "retrieval-bake",
				speakerNormalizationGate: true,
				sceneFactWritePath: true,
				sceneRetrieval: true,
				legacyAreaStateCompat: true,
			},
			{
				name: "final-candidate",
				speakerNormalizationGate: true,
				sceneFactWritePath: true,
				sceneRetrieval: true,
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
					speakerNormalizationGate: true,
					sceneFactWritePath: true,
					sceneRetrieval: false,
					legacyAreaStateCompat: false,
				},
				errorMatrix:
					"(speakerNormalizationGate=true,sceneFactWritePath=true,sceneRetrieval=false,legacyAreaStateCompat=false)",
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
				`[bootstrapRuntime] Unsupported talkerThinker rollout matrix during Tasks 1-11: ${sample.errorMatrix}. Allowed matrices:`,
			);
		}
	});

	describe("post-cleanup validator simulation", () => {
		it("final default matrix (true,true,true,false) is the post-cleanup production matrix and boots successfully today", () => {
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
				expect(runtime.talkerThinkerConfig.speakerNormalizationGate).toBe(true);
				expect(runtime.talkerThinkerConfig.sceneFactWritePath).toBe(true);
				expect(runtime.talkerThinkerConfig.sceneRetrieval).toBe(true);
				expect(runtime.talkerThinkerConfig.legacyAreaStateCompat).toBe(false);
			} finally {
				runtime.shutdown();
			}
		});

		it("read-path rollback matrix (true,true,false,false) is currently rejected by Tasks-1-11 validator — Task 12 will add it", () => {
			// This assertion documents the expected future post-cleanup state.
			// After Task 12, this matrix must PASS bootstrap. For now it is deliberately
			// illegal: Task 12 only needs to add (true,true,false,false) to the allowed list.
			expect(() =>
				bootstrapRuntime({
					runtimeConfig: {
						talkerThinker: {
							...BASE_TALKER_THINKER,
							speakerNormalizationGate: true,
							sceneFactWritePath: true,
							sceneRetrieval: false,
							legacyAreaStateCompat: false,
						},
					},
				}),
			).toThrow(
				"(speakerNormalizationGate=true,sceneFactWritePath=true,sceneRetrieval=false,legacyAreaStateCompat=false)",
			);
		});
	});
});
