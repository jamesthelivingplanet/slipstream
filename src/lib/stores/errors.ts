export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return (
    msg
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^(Uncaught\s+)?Error:\s*/, '')
      .trim() || 'Something went wrong'
  )
}
