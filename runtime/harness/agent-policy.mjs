import { scopeChainOf } from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { officeWorkflow } from './office-workflow.mjs';
const policies = new WeakMap();
const mainPolicies = new WeakMap();
export function bindAgentPolicy(scope, policy) {
  if (policy) policies.set(scope, policy); else policies.delete(scope);
}
export function agentPolicyFor(scope) {
  return scopeChainOf(scope).flatMap(key => [policies.get(key), mainPolicies.get(key)?.()])
    .filter(policy => policy && policy.capabilities !== 'inherit');
}
export function bindMainAgentPolicy(scope, policy) {
  mainPolicies.set(scope, policy);
  return () => { if (mainPolicies.get(scope) === policy) mainPolicies.delete(scope); };
}
// Override the public service interface in the host composition. The upstream
// registry keeps discovery, invalidation and lifecycle ownership unchanged.
export default class AgentSkillRegistry extends SkillRegistry {
  static inject = ['llm'];
  async list(options) { return (await this.snapshot(options)).skills; }
  async snapshot(options) {
    const value = await super.snapshot(options);
    // Native summaries omit provider revisions. Reuse its cached winning
    // candidates so body-only edits invalidate the native published catalog,
    // without loading instructions or building a second skill registry.
    const revision = this.revision;
    const collected = await this.collect(options);
    const policies = agentPolicyFor(options?.scope);
    return { ...value, complete: value.complete && collected.cacheable && revision === this.revision,
      skills: value.skills.filter(skill => policies.every(p => p.skills.includes(skill.name))).map(skill => {
        const contentRevision = collected.entries.get(skill.name)?.candidate.revision;
        return typeof contentRevision === 'string' ? { ...skill, revision: contentRevision } : skill;
      }) };
  }
  async get(name, options) {
    if (agentPolicyFor(options?.scope).some(p => !p.skills.includes(name))) return undefined;
    const skill = await super.get(name, options);
    if (skill?.provider !== 'dsh-office') return skill;
    const agent = options?.scope;
    const route = agent?.session?.requestHeader()?.config ?? agent?.options;
    let info;
    if (route?.provider && route.model) {
      try {
        info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        // Reading installed instructions does not require an available model.
        // Unknown capability keeps Office's existing conservative QA guidance.
      }
    }
    return officeWorkflow(skill, info ? info.inputModalities?.includes('image') === true : undefined);
  }
}
