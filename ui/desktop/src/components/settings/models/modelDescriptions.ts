import type { IntlShape } from 'react-intl';
import { defineMessages } from '../../../i18n';

// Display copy only. Runtime metadata owns capabilities and token limits.
const descriptions = defineMessages({
  // https://ollama.com/library/gemma4
  gemma4: {
    id: 'modelDescriptions.gemma4',
    defaultMessage: 'Google open model for reasoning, coding, and multimodal understanding.',
  },
  // https://ollama.com/library/gemma4
  'custom-gemma4': {
    id: 'modelDescriptions.custom-gemma4',
    defaultMessage: 'A custom quantized Gemma 4 variant; behavior depends on this deployment.',
  },
  // https://ollama.com/library/nemotron-3-super
  'nemotron-3-super': {
    id: 'modelDescriptions.nemotron-3-super',
    defaultMessage: 'NVIDIA MoE model built for efficient, complex multi-agent workloads.',
  },
  // https://ollama.com/library/nemotron-3-ultra
  'nemotron-3-ultra': {
    id: 'modelDescriptions.nemotron-3-ultra',
    defaultMessage: 'NVIDIA model for high-throughput reasoning and long-running agent workflows.',
  },
  // https://ollama.com/library/clef
  clef: {
    id: 'modelDescriptions.clef',
    defaultMessage:
      'Cloudflare multimodal model for structured decision-making from state and typed questions.',
  },
  // https://ollama.com/library/beam
  beam: {
    id: 'modelDescriptions.beam',
    defaultMessage: 'Reflection open model for coding, tool use, and token-efficient reasoning.',
  },
  // https://ollama.com/library/glm-5.2
  'glm-5.2': {
    id: 'modelDescriptions.glm-5.2',
    defaultMessage: 'Z.ai flagship model focused on long-horizon tasks.',
  },
  // https://ollama.com/library/glm-5.3
  'glm-5.3': {
    id: 'modelDescriptions.glm-5.3',
    defaultMessage: 'Z.ai flagship open-weight model for coding and long-horizon agent work.',
  },
  // https://ollama.com/library/glm-5.3-flash
  'glm-5.3-flash': {
    id: 'modelDescriptions.glm-5.3-flash',
    defaultMessage: 'Z.ai native multimodal model focused on coding and agent tasks.',
  },
  // https://ollama.com/library/minimax-m3
  'minimax-m3': {
    id: 'modelDescriptions.minimax-m3',
    defaultMessage: 'MiniMax multimodal model built for coding and agent workflows.',
  },
  // https://ollama.com/library/mistral-large-4
  'mistral-large-4': {
    id: 'modelDescriptions.mistral-large-4',
    defaultMessage: 'Mistral open-weight multimodal model for general-purpose tasks.',
  },
  // https://ollama.com/library/deepseek-v4.1-flash
  'deepseek-v4.1-flash': {
    id: 'modelDescriptions.deepseek-v4.1-flash',
    defaultMessage: 'DeepSeek model designed for faster inference and higher throughput.',
  },
  // https://ollama.com/library/muse-spark-open
  'muse-spark-open': {
    id: 'modelDescriptions.muse-spark-open',
    defaultMessage:
      'Open multimodal model for coding, software engineering, and multi-step reasoning.',
  },
  // https://ollama.com/library/kimi-k2.7-code
  'kimi-k2.7-code': {
    id: 'modelDescriptions.kimi-k2.7-code',
    defaultMessage: 'Moonshot coding model focused on real-world, long-horizon programming tasks.',
  },
  // https://ollama.com/library/kimi-k3
  'kimi-k3': {
    id: 'modelDescriptions.kimi-k3',
    defaultMessage: 'Kimi open-weight native multimodal model for agent workflows.',
  },
  // https://ollama.com/library/nemotron-3-nano
  'nemotron-3-nano': {
    id: 'modelDescriptions.nemotron-3-nano',
    defaultMessage: 'NVIDIA lightweight open model focused on efficient agent workflows.',
  },
  // https://ollama.com/library/deepseek-v4-pro
  'deepseek-v4-pro': {
    id: 'modelDescriptions.deepseek-v4-pro',
    defaultMessage: 'DeepSeek MoE model for complex reasoning and long-context tasks.',
  },
  // https://ollama.com/library/gpt-oss
  'gpt-oss': {
    id: 'modelDescriptions.gpt-oss',
    defaultMessage:
      'OpenAI open-weight models for reasoning, agent tasks, and developer workflows.',
  },
  // https://ollama.com/library/mistral-large-3
  'mistral-large-3': {
    id: 'modelDescriptions.mistral-large-3',
    defaultMessage: 'Mistral multimodal MoE model for production and enterprise workloads.',
  },
  // https://ollama.com/library/kimi-k2.6
  'kimi-k2.6': {
    id: 'modelDescriptions.kimi-k2.6',
    defaultMessage: 'Kimi open multimodal model for long-horizon coding and agent orchestration.',
  },
  // https://ollama.com/library/minimax-m2.7
  'minimax-m2.7': {
    id: 'modelDescriptions.minimax-m2.7',
    defaultMessage: 'MiniMax model for coding, agent workflows, and professional productivity.',
  },
  custom: {
    id: 'modelDescriptions.custom',
    defaultMessage: 'Custom model provided by {provider}.',
  },
});

export function getModelDescription(intl: IntlShape, model: string, provider: string): string {
  const key =
    model.toLowerCase() === 'gemma-4-26b-a4b-it-uncensored-fp8-w8a16'
      ? 'custom-gemma4'
      : model.toLowerCase().split(':')[0];
  const message = Object.prototype.hasOwnProperty.call(descriptions, key)
    ? descriptions[key as keyof typeof descriptions]
    : descriptions.custom;
  return intl.formatMessage(message, { provider });
}
