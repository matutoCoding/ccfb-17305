import React, { useEffect, useState } from 'react'

type ToastType = 'ok' | 'err' | 'info'
interface Item {
  id: number
  msg: string
  type: ToastType
}
let seq = 0

export function toast(msg: string, type: ToastType = 'ok') {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { id: ++seq, msg, type } }))
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => {
    const h = (e: Event) => {
      const it = (e as CustomEvent<Item>).detail
      setItems((x) => [...x, it])
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== it.id)), 3600)
    }
    window.addEventListener('app-toast', h)
    return () => window.removeEventListener('app-toast', h)
  }, [])
  return (
    <div className="toast-wrap">
      {items.map((i) => (
        <div key={i.id} className={`toast ${i.type === 'err' ? 'err' : 'ok'}`}>
          {i.msg}
        </div>
      ))}
    </div>
  )
}
