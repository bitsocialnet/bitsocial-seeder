export const isAlreadyPinnedError = (error: any) => {
  const message = error?.message || String(error || '')
  return /already pinned/i.test(message)
}
