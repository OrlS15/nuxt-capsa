import { defineEventHandler } from 'nuxt/server'
import { serveSigned } from '#capsa/drive'

// Answers the links capsa signs for a disk on fs, on `/_capsa/drive/<disk>/<key>`.
export default defineEventHandler(serveSigned)
