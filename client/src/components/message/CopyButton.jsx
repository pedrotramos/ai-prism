import { useEffect, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.tsx'
import ActionButton from './ActionButton.jsx'

// Copies `text` and shows a check for 1.4 s. The name stays the action
// ("Copy"); the confirmation is the icon plus the tooltip.
export default function CopyButton({ text, label, className }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const name = label ?? t('message.copy')
  return (
    <ActionButton
      label={done ? t('message.copied') : name}
      className={className}
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setDone(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? <Icon.Check size={15} className="text-success" /> : <Icon.Copy size={15} />}
    </ActionButton>
  )
}
