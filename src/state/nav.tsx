import React, { createContext, useContext } from 'react'

export type PageKey = 'pipelines' | 'isometric' | 'data' | 'viewer' | 'life' | 'plan'

export interface NavParams {
  pipelineId?: string
  pointId?: string
  fittingId?: string
  mode?: 'ratio' | 'long' | 'short' | 'diff'
  showSuggestions?: boolean
  periodId?: string
  periodA?: string
  periodB?: string
}

export interface NavState {
  page: PageKey
  params: NavParams
  go: (page: PageKey, params?: NavParams) => void
}

export const NavCtx = createContext<NavState>({ page: 'pipelines', params: {}, go: () => {} })
export const useNav = () => useContext(NavCtx)

export function NavProvider({ children, value }: { children: React.ReactNode; value: NavState }) {
  return <NavCtx.Provider value={value}>{children}</NavCtx.Provider>
}
