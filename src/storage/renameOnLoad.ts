// Imported first by main.tsx: settings are read from localStorage as soon as their store
// module loads, so the old keys have to be moved before any other import runs.
import { migrateLocalStorage } from './migrateName'

migrateLocalStorage()
