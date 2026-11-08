import { useEffect } from 'react'
import { useTable } from 'spacetimedb/react'
import { touchLink } from './session.ts'

export function useRows<Query extends Parameters<typeof useTable>[0]>(query: Query) {
  const result = useTable(query)
  useEffect(() => {
    if (result[1]) touchLink()
  }, [result])
  return result
}
