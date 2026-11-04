import { scopeChainOf } from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
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
  async list(options) { return (await this.snapshot(options)).skills; }
  async snapshot(options) {
    const value = await super.snapshot(options);
    const policies = agentPolicyFor(options?.scope);
    return { ...value, skills: value.skills.filter(skill => policies.every(p => p.skills.includes(skill.name))) };
  }
  async get(name, options) {
    if (agentPolicyFor(options?.scope).some(p => !p.skills.includes(name))) return undefined;
    return super.get(name, options);
  }
}
