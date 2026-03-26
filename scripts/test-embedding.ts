#!/usr/bin/env bun
/**
 * Embedding 模型健康检查脚本
 * 测试阿里云百炼 (Bailian) 的 text-embedding-v4 模型
 */

import { OpenAIProvider } from "../src/core/models/openai-provider.js";

const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY;
const BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode";
const EMBEDDING_MODEL = "text-embedding-v4";

interface TestResult {
  provider: string;
  model: string;
  status: "ok" | "error";
  latencyMs: number;
  vectorDimensions?: number;
  sampleVector?: number[];
  error?: string;
}

async function testEmbedding(): Promise<TestResult> {
  const startTime = Date.now();
  
  if (!BAILIAN_API_KEY) {
    return {
      provider: "bailian",
      model: EMBEDDING_MODEL,
      status: "error",
      latencyMs: 0,
      error: "BAILIAN_API_KEY 环境变量未设置",
    };
  }

  const provider = new OpenAIProvider({
    apiKey: BAILIAN_API_KEY,
    baseUrl: BAILIAN_BASE_URL,
    defaultEmbeddingModel: EMBEDDING_MODEL,
  });

  const testTexts = [
    "这是一个测试句子，用于验证 embedding 模型是否正常工作。",
    "MaidsClaw is a multi-agent engine with maid-themed architecture.",
  ];

  try {
    const embeddings = await provider.embed(testTexts, "memory_index", EMBEDDING_MODEL);
    const latencyMs = Date.now() - startTime;

    if (embeddings.length !== testTexts.length) {
      return {
        provider: "bailian",
        model: EMBEDDING_MODEL,
        status: "error",
        latencyMs,
        error: `返回的 embedding 数量不匹配: 期望 ${testTexts.length}, 实际 ${embeddings.length}`,
      };
    }

    // 验证向量维度
    const firstVector = embeddings[0];
    const dimensions = firstVector.length;

    // 验证向量是否合理 (不是全零或 NaN)
    const hasValidValues = firstVector.some(v => v !== 0 && !Number.isNaN(v));
    if (!hasValidValues) {
      return {
        provider: "bailian",
        model: EMBEDDING_MODEL,
        status: "error",
        latencyMs,
        vectorDimensions: dimensions,
        error: "Embedding 向量包含全零或无效值",
      };
    }

    return {
      provider: "bailian",
      model: EMBEDDING_MODEL,
      status: "ok",
      latencyMs,
      vectorDimensions: dimensions,
      sampleVector: Array.from(firstVector.slice(0, 5)),
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      provider: "bailian",
      model: EMBEDDING_MODEL,
      status: "error",
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testCosineSimilarity(): Promise<void> {
  console.log("\n📐 测试余弦相似度计算...\n");
  
  const provider = new OpenAIProvider({
    apiKey: BAILIAN_API_KEY || "",
    baseUrl: BAILIAN_BASE_URL,
    defaultEmbeddingModel: EMBEDDING_MODEL,
  });

  // 使用本地计算验证余弦相似度
  const testPairs = [
    { a: new Float32Array([1, 0, 0]), b: new Float32Array([1, 0, 0]), expected: 1 },
    { a: new Float32Array([1, 0, 0]), b: new Float32Array([0, 1, 0]), expected: 0 },
    { a: new Float32Array([1, 1, 0]), b: new Float32Array([1, 1, 0]), expected: 1 },
  ];

  for (const { a, b, expected } of testPairs) {
    // 使用 provider 的 cosineSimilarity 方法
    const similarity = provider.cosineSimilarity?.(a, b) ?? calculateCosineSimilarity(a, b);
    const passed = Math.abs(similarity - expected) < 0.0001;
    console.log(`  ${passed ? "✓" : "✗"} 相似度: ${similarity.toFixed(4)} (期望: ${expected})`);
  }
}

function calculateCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("🔍 MaidsClaw Embedding 模型健康检查");
  console.log("=".repeat(60));

  // 1. 测试 API 连接
  console.log("\n📡 测试 Embedding API 连接...\n");
  const result = await testEmbedding();

  console.log(`  提供商: ${result.provider}`);
  console.log(`  模型: ${result.model}`);
  console.log(`  状态: ${result.status === "ok" ? "✅ 正常" : "❌ 异常"}`);
  console.log(`  延迟: ${result.latencyMs}ms`);
  
  if (result.vectorDimensions) {
    console.log(`  向量维度: ${result.vectorDimensions}`);
  }
  
  if (result.sampleVector) {
    console.log(`  样本向量 (前5维): [${result.sampleVector.map(v => v.toFixed(4)).join(", ")}]`);
  }
  
  if (result.error) {
    console.log(`  错误: ${result.error}`);
  }

  // 2. 测试余弦相似度计算
  await testCosineSimilarity();

  // 3. 测试语义相似度
  if (result.status === "ok") {
    console.log("\n🧠 测试语义相似度...\n");
    
    const provider = new OpenAIProvider({
      apiKey: BAILIAN_API_KEY || "",
      baseUrl: BAILIAN_BASE_URL,
      defaultEmbeddingModel: EMBEDDING_MODEL,
    });

    const texts = [
      "猫是一种可爱的宠物",
      "狗是人类忠实的朋友",
      "猫咪喜欢追逐激光笔",
      "量子力学是物理学的一个分支",
    ];

    console.log("  文本:");
    texts.forEach((t, i) => console.log(`    ${i + 1}. ${t}`));

    const embeddings = await provider.embed(texts, "narrative_search", EMBEDDING_MODEL);
    
    console.log("\n  相似度矩阵 (猫 vs 其他):");
    const catEmbedding = embeddings[0];
    for (let i = 1; i < texts.length; i++) {
      const similarity = provider.cosineSimilarity?.(catEmbedding, embeddings[i]) ?? 
                        calculateCosineSimilarity(catEmbedding, embeddings[i]);
      console.log(`    猫 vs ${texts[i].substring(0, 15)}...: ${similarity.toFixed(4)}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(result.status === "ok" ? "✅ Embedding 模型工作正常" : "❌ Embedding 模型存在问题");
  console.log("=".repeat(60));

  process.exit(result.status === "ok" ? 0 : 1);
}

main();
