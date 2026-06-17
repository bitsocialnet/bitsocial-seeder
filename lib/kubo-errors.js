export const isAlreadyPinnedError = (error) => {
  const message = error?.message || String(error || '')
  return /already pinned/i.test(message)
}
