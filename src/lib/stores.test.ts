import { describe, it, expect } from 'vitest'
import { isStartableTicket } from './ticketFilter.js'

describe('isStartableTicket', () => {
  it('keeps a backlog ticket (type backlog, done false)', () => {
    expect(isStartableTicket({ done: false, status: { id: '1', name: 'Backlog', type: 'backlog' } })).toBe(true)
  })

  it('keeps a ticket with no status type (done false)', () => {
    expect(isStartableTicket({ done: false, status: undefined })).toBe(true)
  })

  it('keeps a ticket with status type unstarted', () => {
    expect(isStartableTicket({ done: false, status: { id: '2', name: 'Todo', type: 'unstarted' } })).toBe(true)
  })

  it('excludes a ticket with done: true', () => {
    expect(isStartableTicket({ done: true, status: undefined })).toBe(false)
  })

  it('excludes a ticket with status.type === started (In Progress)', () => {
    expect(isStartableTicket({ done: false, status: { id: '3', name: 'In Progress', type: 'started' } })).toBe(false)
  })

  it('excludes a ticket with status.type === canceled', () => {
    expect(isStartableTicket({ done: false, status: { id: '4', name: 'Canceled', type: 'canceled' } })).toBe(false)
  })
})
