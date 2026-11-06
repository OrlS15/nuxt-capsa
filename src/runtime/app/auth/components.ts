import { computed, defineComponent } from 'vue'
import abilities from '#build/capsa/auth/abilities.mjs'
import type { CanComponent, CannotComponent } from '../../auth'
import { argsOf, judge, shown } from '../../auth/rules'
import { useCapsaSession } from './session'

const props = { do: { type: String, required: true }, with: { type: null, default: undefined } } as const

/** What the rule says about the visitor, reactive: undefined while unknown, null when it lets in, else the refusal. */
function useRefusal(rule: { do: string, with: unknown }) {
  const { user, resolved } = useCapsaSession()

  return computed(() => {
    const args = argsOf(abilities, rule.do, rule.with)

    return resolved.value && !args.includes(undefined) ? judge(abilities, user.value, rule.do, args) : undefined
  })
}

/**
 * Shows its content when the visitor may do something, `#denied` with the refusal when not, and nothing while the
 * session is still being read.
 *
 * @example
 * <Can do="post.delete" :with="post">
 *   <button>Delete</button>
 *   <template #denied="{ code }">{{ t(`errors.${code}`) }}</template>
 * </Can>
 */
export const Can = defineComponent({
  name: 'Can',
  props,
  setup(rule, { slots }) {
    const refusal = useRefusal(rule)

    return () => refusal.value === undefined ? null : refusal.value === null ? slots.default?.() : slots.denied?.(shown(refusal.value))
  },
}) as unknown as CanComponent

/**
 * Shows its content, with the refusal, only when the visitor may not do something.
 *
 * @example
 * <Cannot do="schedulePost" v-slot="{ code }"><UpgradeHint :code="code" /></Cannot>
 */
export const Cannot = defineComponent({
  name: 'Cannot',
  props,
  setup(rule, { slots }) {
    const refusal = useRefusal(rule)

    return () => refusal.value ? slots.default?.(shown(refusal.value)) : null
  },
}) as unknown as CannotComponent
