import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  zCodeProMemoryDeleteRequest_unstable,
  zCodeProMemoryGetRequest_unstable,
  zCodeProMemoryListRequest_unstable,
  zCodeProMemoryListResponse_unstable,
  zCodeProMemoryStatusRequest_unstable,
  zCodeProMemoryUpdateRequest_unstable,
} from '@aaif/goose-sdk';
import { getAcpClient } from './acpConnection';
import { AcpTransportError } from './createWebSocketStream';
import {
  deleteCodeProMemory,
  exportCodeProMemory,
  listCodeProMemory,
  setCodeProMemoryStatus,
  updateCodeProMemory,
} from './memory';

vi.mock('./acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

describe('CodePro memory ACP client', () => {
  const codeproMemoryList = vi.fn();
  const codeproMemoryUpdate = vi.fn();
  const codeproMemoryDelete = vi.fn();
  const codeproMemoryExport = vi.fn();
  const codeproMemoryGet = vi.fn();
  const codeproMemoryStatus = vi.fn();

  beforeEach(() => {
    for (const mock of [
      codeproMemoryList,
      codeproMemoryUpdate,
      codeproMemoryDelete,
      codeproMemoryExport,
      codeproMemoryGet,
      codeproMemoryStatus,
    ]) {
      mock.mockReset();
    }
    vi.mocked(getAcpClient).mockReset();
    vi.mocked(getAcpClient).mockResolvedValue({
      goose: {
        codeproMemoryList_unstable: codeproMemoryList,
        codeproMemoryUpdate_unstable: codeproMemoryUpdate,
        codeproMemoryDelete_unstable: codeproMemoryDelete,
        codeproMemoryExport_unstable: codeproMemoryExport,
        codeproMemoryGet_unstable: codeproMemoryGet,
        codeproMemoryStatus_unstable: codeproMemoryStatus,
      },
    } as never);
  });

  const reviewRecord = (overrides: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'preference',
    subject: 'response.style',
    content: 'Keep answers compact.',
    scope: 'user',
    source: 'user_inferred',
    status: 'candidate',
    reason: 'Learned from repeated requests',
    confidence: 'medium',
    createdAt: '2026-09-12T00:00:00.000000000Z',
    updatedAt: '2026-09-12T00:00:01.000000000Z',
    expired: false,
    recallable: false,
    reviewFingerprint: 'a'.repeat(64),
    ...overrides,
  });
  const transportError = () => new AcpTransportError('ACP WebSocket connection lost', 'unknown');

  it('sends versioned list and update requests', async () => {
    codeproMemoryList.mockResolvedValueOnce({
      schemaVersion: 1,
      projectIdentity: 'a'.repeat(32),
      records: [],
      totalRecords: 0,
      usageBytes: 0,
      softLimitBytes: 1024,
      hardLimitBytes: 2048,
    });
    codeproMemoryUpdate.mockResolvedValueOnce({ record: { id: 'm1', content: 'edited' } });

    await listCodeProMemory('D:\\project', true);
    await updateCodeProMemory({
      workingDir: 'D:\\project',
      id: 'm1',
      content: 'edited',
      reason: 'user correction',
    });

    expect(codeproMemoryList).toHaveBeenCalledWith({
      schemaVersion: 1,
      workingDir: 'D:\\project',
      includeExpired: true,
    });
    expect(codeproMemoryUpdate).toHaveBeenCalledWith({
      schemaVersion: 1,
      workingDir: 'D:\\project',
      id: 'm1',
      content: 'edited',
      reason: 'user correction',
    });
  });

  it('uses distinct destructive and export methods', async () => {
    codeproMemoryDelete.mockResolvedValueOnce({ removed: true });
    codeproMemoryExport.mockResolvedValueOnce({ fileName: 'memory.json', json: '{}' });

    await expect(deleteCodeProMemory('D:\\project', 'm1')).resolves.toBe(true);
    await expect(exportCodeProMemory('D:\\project')).resolves.toEqual({
      fileName: 'memory.json',
      json: '{}',
    });
    expect(codeproMemoryDelete).toHaveBeenCalledWith({
      schemaVersion: 1,
      workingDir: 'D:\\project',
      id: 'm1',
    });
    expect(codeproMemoryExport).toHaveBeenCalledWith({
      schemaVersion: 1,
      workingDir: 'D:\\project',
      includeExpired: false,
    });
  });

  it('reports a direct status response as committed', async () => {
    const active = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:02.000000000Z',
      recallable: true,
    });
    codeproMemoryStatus.mockImplementationOnce(async (request) => ({
      actionId: request.actionId,
      changed: true,
      record: active,
    }));

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({ outcome: 'committed', record: active, changed: true });
    expect(codeproMemoryGet).not.toHaveBeenCalled();
    expect(codeproMemoryStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: reviewRecord().id,
        targetStatus: 'active',
        expectedStatus: 'candidate',
        expectedUpdatedAt: reviewRecord().updatedAt,
        reviewFingerprint: 'a'.repeat(64),
        actionId: expect.any(String),
      })
    );
  });

  it('does not read back or retry a deterministic status conflict', async () => {
    const conflict = {
      error: {
        message: 'Memory changed',
        data: { code: 'memory_review_conflict' },
      },
    };
    codeproMemoryStatus.mockRejectedValueOnce(conflict);

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).rejects.toBe(conflict);
    expect(codeproMemoryGet).not.toHaveBeenCalled();
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('does not read back or retry when the transport proves the request was not sent', async () => {
    const notSent = new AcpTransportError('ACP WebSocket connection lost', 'not_sent');
    codeproMemoryStatus.mockRejectedValueOnce(notSent);

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).rejects.toBe(notSent);
    expect(codeproMemoryGet).not.toHaveBeenCalled();
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('reconciles a target status after an unknown transport result without claiming a commit', async () => {
    const active = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:02.000000000Z',
      recallable: true,
    });
    codeproMemoryStatus.mockRejectedValueOnce(transportError());
    codeproMemoryGet.mockResolvedValueOnce({ record: active });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({
      outcome: 'reconciled_after_readback',
      record: active,
      changed: null,
    });
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
    expect(codeproMemoryGet).toHaveBeenCalledTimes(1);
  });

  it('reacquires the ACP client before readback after an unknown transport result', async () => {
    const staleMemoryGet = vi.fn();
    const freshMemoryGet = vi.fn();
    const active = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:02.000000000Z',
      recallable: true,
    });
    codeproMemoryStatus.mockRejectedValueOnce(transportError());
    freshMemoryGet.mockResolvedValueOnce({ record: active });
    vi.mocked(getAcpClient)
      .mockResolvedValueOnce({
        goose: {
          codeproMemoryGet_unstable: staleMemoryGet,
          codeproMemoryStatus_unstable: codeproMemoryStatus,
        },
      } as never)
      .mockResolvedValueOnce({
        goose: {
          codeproMemoryGet_unstable: freshMemoryGet,
          codeproMemoryStatus_unstable: vi.fn(),
        },
      } as never);

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({
      outcome: 'reconciled_after_readback',
      record: active,
      changed: null,
    });
    expect(getAcpClient).toHaveBeenCalledTimes(2);
    expect(staleMemoryGet).not.toHaveBeenCalled();
    expect(freshMemoryGet).toHaveBeenCalledTimes(1);
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('retries the unchanged snapshot once with the same action id', async () => {
    const initial = reviewRecord();
    const active = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:02.000000000Z',
      recallable: true,
    });
    codeproMemoryStatus
      .mockRejectedValueOnce(transportError())
      .mockImplementationOnce(async (request) => ({
        actionId: request.actionId,
        changed: true,
        record: active,
      }));
    codeproMemoryGet.mockResolvedValueOnce({ record: initial });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: initial as never,
        targetStatus: 'active',
      })
    ).resolves.toMatchObject({ outcome: 'committed', changed: true });
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(2);
    expect(codeproMemoryStatus.mock.calls[0][0].actionId).toBe(
      codeproMemoryStatus.mock.calls[1][0].actionId
    );
  });

  it('requires review when readback semantics changed', async () => {
    const changed = reviewRecord({
      content: 'A different preference won the race.',
      reviewFingerprint: 'b'.repeat(64),
      updatedAt: '2026-09-12T00:00:02.000000000Z',
    });
    codeproMemoryStatus.mockRejectedValueOnce(transportError());
    codeproMemoryGet.mockResolvedValueOnce({ record: changed });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({ outcome: 'needs_review', record: changed, changed: null });
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('never retries an unchanged snapshot more than once', async () => {
    const initial = reviewRecord();
    codeproMemoryStatus.mockRejectedValue(transportError());
    codeproMemoryGet.mockResolvedValue({ record: initial });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: initial as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({ outcome: 'needs_review', record: initial, changed: null });
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(2);
    expect(codeproMemoryGet).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong id', { id: '00000000-0000-4000-8000-000000000002' }],
    ['wrong status', { status: 'disabled' }],
    ['wrong fingerprint', { reviewFingerprint: 'b'.repeat(64) }],
  ])('does not report a direct response with %s as committed', async (_label, overrides) => {
    const mismatched = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:02.000000000Z',
      recallable: true,
      ...overrides,
    });
    codeproMemoryStatus.mockImplementationOnce(async (request) => ({
      actionId: request.actionId,
      changed: true,
      record: mismatched,
    }));
    codeproMemoryGet.mockResolvedValueOnce({ record: reviewRecord() });
    codeproMemoryStatus.mockRejectedValueOnce({
      error: { message: 'stale', data: { code: 'memory_review_conflict' } },
    });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).rejects.toBeDefined();
    expect(codeproMemoryGet).toHaveBeenCalledTimes(1);
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'reports changed false for a real transition',
      reviewRecord(),
      'active',
      false,
      reviewRecord({
        status: 'active',
        updatedAt: '2026-09-12T00:00:02.000000000Z',
        recallable: true,
      }),
    ],
    [
      'keeps the old timestamp for a changed transition',
      reviewRecord(),
      'active',
      true,
      reviewRecord({ status: 'active', recallable: true }),
    ],
  ])(
    'does not report committed when the direct receipt %s',
    async (_label, snapshot, targetStatus, changed, responseRecord) => {
      codeproMemoryStatus.mockImplementationOnce(async (request) => ({
        actionId: request.actionId,
        changed,
        record: responseRecord,
      }));
      codeproMemoryGet.mockResolvedValueOnce({ record: snapshot });
      codeproMemoryStatus.mockRejectedValueOnce({
        error: { message: 'stale', data: { code: 'memory_review_conflict' } },
      });

      await expect(
        setCodeProMemoryStatus({
          workingDir: 'D:\\project',
          record: snapshot as never,
          targetStatus: targetStatus as never,
        })
      ).rejects.toBeDefined();
      expect(codeproMemoryGet).toHaveBeenCalledTimes(1);
      expect(codeproMemoryStatus).toHaveBeenCalledTimes(2);
    }
  );

  it('does not claim a no-op commit when the direct receipt changes the timestamp', async () => {
    const snapshot = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:02.000000000Z',
      recallable: true,
    });
    const contradictory = reviewRecord({
      status: 'active',
      updatedAt: '2026-09-12T00:00:03.000000000Z',
      recallable: true,
    });
    codeproMemoryStatus.mockImplementationOnce(async (request) => ({
      actionId: request.actionId,
      changed: false,
      record: contradictory,
    }));
    codeproMemoryGet.mockResolvedValueOnce({ record: snapshot });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: snapshot as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({
      outcome: 'reconciled_after_readback',
      record: snapshot,
      changed: null,
    });
    expect(codeproMemoryGet).toHaveBeenCalledTimes(1);
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a readback record with the wrong id', async () => {
    codeproMemoryStatus.mockRejectedValueOnce(transportError());
    codeproMemoryGet.mockResolvedValueOnce({
      record: reviewRecord({
        id: '00000000-0000-4000-8000-000000000002',
        status: 'active',
      }),
    });

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({ outcome: 'needs_review', record: null, changed: null });
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('returns needs_review when exact readback fails after an unknown result', async () => {
    codeproMemoryStatus.mockRejectedValueOnce(transportError());
    codeproMemoryGet.mockRejectedValueOnce(new Error('readback unavailable'));

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).resolves.toEqual({ outcome: 'needs_review', record: null, changed: null });
    expect(codeproMemoryStatus).toHaveBeenCalledTimes(1);
  });

  it('does not classify backend wording as an unknown commit without a structured code', async () => {
    const deterministic = new Error('network policy closed this request');
    codeproMemoryStatus.mockRejectedValueOnce(deterministic);

    await expect(
      setCodeProMemoryStatus({
        workingDir: 'D:\\project',
        record: reviewRecord() as never,
        targetStatus: 'active',
      })
    ).rejects.toBe(deterministic);
    expect(codeproMemoryGet).not.toHaveBeenCalled();
  });

  it('accepts zero compatibility limits as unlimited storage metadata', async () => {
    codeproMemoryList.mockResolvedValueOnce({
      schemaVersion: 1,
      projectIdentity: 'a'.repeat(32),
      records: [],
      totalRecords: 0,
      usageBytes: 3 * 1024 * 1024,
      softLimitBytes: 0,
      hardLimitBytes: 0,
    });

    await expect(listCodeProMemory('D:\\project')).resolves.toMatchObject({
      usageBytes: 3 * 1024 * 1024,
      softLimitBytes: 0,
      hardLimitBytes: 0,
    });
  });

  it('forwards bounded pagination only when requested', async () => {
    codeproMemoryList.mockResolvedValueOnce({
      schemaVersion: 1,
      projectIdentity: 'a'.repeat(32),
      records: [{ id: '00000000-0000-4000-8000-000000000050' }],
      totalRecords: 75,
      nextCursor: '00000000-0000-4000-8000-000000000050',
      usageBytes: 0,
      softLimitBytes: 1024,
      hardLimitBytes: 2048,
    });

    await listCodeProMemory('D:\\project', false, {
      pageSize: 50,
      cursor: '00000000-0000-4000-8000-000000000000',
    });

    expect(codeproMemoryList).toHaveBeenCalledWith({
      schemaVersion: 1,
      workingDir: 'D:\\project',
      includeExpired: false,
      pageSize: 50,
      cursor: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('rejects invalid pagination before opening an ACP connection', async () => {
    await expect(listCodeProMemory('D:\\project', false, { pageSize: 0 })).rejects.toThrow(
      'Memory pageSize must be an integer between 1 and 50'
    );
    await expect(listCodeProMemory('D:\\project', false, { pageSize: 51 })).rejects.toThrow(
      'Memory pageSize must be an integer between 1 and 50'
    );
    await expect(listCodeProMemory('D:\\project', false, { pageSize: 1.5 })).rejects.toThrow(
      'Memory pageSize must be an integer between 1 and 50'
    );
    await expect(listCodeProMemory('D:\\project', false, { cursor: ' ' })).rejects.toThrow(
      'Memory cursor must contain between 1 and 36 characters'
    );
    await expect(
      listCodeProMemory('D:\\project', false, { cursor: 'x'.repeat(37) })
    ).rejects.toThrow('Memory cursor must contain between 1 and 36 characters');
    await expect(
      listCodeProMemory('D:\\project', false, { cursor: 'x'.repeat(36) })
    ).rejects.toThrow('Memory cursor must be a UUID');
    expect(getAcpClient).not.toHaveBeenCalled();
  });

  it('rejects contradictory capacity and pagination metadata', async () => {
    const baseResponse = {
      schemaVersion: 1,
      projectIdentity: 'a'.repeat(32),
      records: [],
      totalRecords: 0,
      usageBytes: 0,
      softLimitBytes: 1024,
      hardLimitBytes: 2048,
    };
    codeproMemoryList.mockResolvedValueOnce({
      ...baseResponse,
      records: [{ id: '00000000-0000-4000-8000-000000000001' }],
    });
    await expect(listCodeProMemory('D:\\project')).rejects.toThrow(
      'Memory response contains more records than totalRecords'
    );

    codeproMemoryList.mockResolvedValueOnce({
      ...baseResponse,
      softLimitBytes: 4096,
    });
    await expect(listCodeProMemory('D:\\project')).rejects.toThrow(
      'Memory response softLimitBytes must not exceed hardLimitBytes'
    );

    codeproMemoryList.mockResolvedValueOnce({
      ...baseResponse,
      nextCursor: '00000000-0000-4000-8000-000000000000',
    });
    await expect(listCodeProMemory('D:\\project')).rejects.toThrow(
      'Memory response must not advance pagination from an empty page'
    );

    codeproMemoryList.mockResolvedValueOnce({
      ...baseResponse,
      records: [{ id: '00000000-0000-4000-8000-000000000001' }],
      totalRecords: 2,
      nextCursor: '00000000-0000-4000-8000-000000000002',
    });
    await expect(listCodeProMemory('D:\\project')).rejects.toThrow(
      'Memory response nextCursor must match the final record id'
    );
  });

  it('rejects malformed project and record identities', async () => {
    const baseResponse = {
      schemaVersion: 1,
      projectIdentity: 'a'.repeat(32),
      records: [],
      totalRecords: 0,
      usageBytes: 0,
      softLimitBytes: 1024,
      hardLimitBytes: 2048,
    };
    codeproMemoryList.mockResolvedValueOnce({
      ...baseResponse,
      projectIdentity: 'z'.repeat(32),
    });
    await expect(listCodeProMemory('D:\\project')).rejects.toThrow(
      'Memory response projectIdentity must be a 32-character hexadecimal id'
    );

    codeproMemoryList.mockResolvedValueOnce({
      ...baseResponse,
      records: [{ id: 'x'.repeat(36) }],
      totalRecords: 1,
    });
    await expect(listCodeProMemory('D:\\project')).rejects.toThrow(
      'Memory response record id must be a UUID'
    );
  });

  it('keeps generated request and response schemas capacity-bounded', () => {
    expect(
      zCodeProMemoryListRequest_unstable.safeParse({
        schemaVersion: 1,
        workingDir: 'D:\\project',
        pageSize: 51,
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryListRequest_unstable.safeParse({
        schemaVersion: 1,
        workingDir: 'D:\\project',
        cursor: '',
      }).success
    ).toBe(false);

    const boundedResponse = {
      schemaVersion: 1,
      projectIdentity: 'a'.repeat(32),
      records: [],
      nextCursor: null,
      totalRecords: 0,
      usageBytes: 0,
      softLimitBytes: 1024 * 1024,
      hardLimitBytes: 2 * 1024 * 1024,
    };
    const validRecord = {
      id: '00000000-0000-4000-8000-000000000000',
      kind: 'verified_fact',
      subject: 'verified.fact',
      content: 'Bounded fact',
      scope: 'project',
      source: 'user_explicit',
      status: 'active',
      reason: 'Capacity boundary test',
      confidence: 'high',
      createdAt: '2026-08-23T00:00:00Z',
      updatedAt: '2026-08-23T00:00:00Z',
      expired: false,
      recallable: true,
    };
    expect(zCodeProMemoryListResponse_unstable.safeParse(boundedResponse).success).toBe(true);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        projectIdentity: 'a'.repeat(31),
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        projectIdentity: 'z'.repeat(32),
      }).success
    ).toBe(false);
    for (const [field, value] of Object.entries({
      kind: 'x'.repeat(33),
      scope: 'x'.repeat(17),
      source: 'x'.repeat(33),
      confidence: 'x'.repeat(17),
    })) {
      expect(
        zCodeProMemoryListResponse_unstable.safeParse({
          ...boundedResponse,
          records: [{ ...validRecord, [field]: value }],
          totalRecords: 1,
        }).success,
        field
      ).toBe(false);
    }
    for (const field of ['createdAt', 'updatedAt', 'lastVerifiedAt', 'expiresAt']) {
      expect(
        zCodeProMemoryListResponse_unstable.safeParse({
          ...boundedResponse,
          records: [{ ...validRecord, [field]: 'x'.repeat(65) }],
          totalRecords: 1,
        }).success,
        field
      ).toBe(false);
    }
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        nextCursor: 'x'.repeat(37),
      }).success
    ).toBe(false);
    const { hardLimitBytes: _missingHardLimit, ...unboundedResponse } = boundedResponse;
    expect(zCodeProMemoryListResponse_unstable.safeParse(unboundedResponse).success).toBe(false);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        records: [{ ...validRecord, id: 'x'.repeat(35) }],
        totalRecords: 1,
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        records: [{ ...validRecord, id: 'x'.repeat(36) }],
        totalRecords: 1,
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        records: Array.from({ length: 51 }, (_, index) => ({
          ...validRecord,
          id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
          content: `Fact ${index}`,
        })),
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        records: [
          {
            ...validRecord,
            content: 'x'.repeat(2001),
          },
        ],
        totalRecords: 1,
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryListResponse_unstable.safeParse({
        ...boundedResponse,
        records: [
          {
            ...validRecord,
            source: 'project_evidence',
            sourceRef: 'x'.repeat(1025),
          },
        ],
        totalRecords: 1,
      }).success
    ).toBe(false);
  });

  it('uses generated strict schemas for exact readback and status review', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const actionId = '00000000-0000-4000-8000-000000000002';
    expect(
      zCodeProMemoryGetRequest_unstable.safeParse({
        schemaVersion: 1,
        workingDir: 'D:\\project',
        id,
      }).success
    ).toBe(true);
    expect(
      zCodeProMemoryGetRequest_unstable.safeParse({
        schemaVersion: 1,
        workingDir: 'D:\\project',
        id: 'not-a-uuid',
      }).success
    ).toBe(false);

    const request = {
      schemaVersion: 1,
      workingDir: 'D:\\project',
      id,
      targetStatus: 'active',
      expectedStatus: 'candidate',
      expectedUpdatedAt: '2026-09-12T00:00:01.000000000Z',
      reviewFingerprint: 'a'.repeat(64),
      actionId,
    };
    expect(zCodeProMemoryStatusRequest_unstable.safeParse(request).success).toBe(true);
    expect(
      zCodeProMemoryStatusRequest_unstable.safeParse({
        ...request,
        targetStatus: 'candidate',
      }).success
    ).toBe(false);
  });

  it('keeps generated mutation schemas aligned with backend validation', () => {
    const update = {
      schemaVersion: 1,
      workingDir: 'D:\\project',
      id: '00000000-0000-4000-8000-000000000000',
      content: 'Bounded fact',
      reason: 'Verified by a focused test',
      ttlDays: 30,
    };
    expect(zCodeProMemoryUpdateRequest_unstable.safeParse(update).success).toBe(true);
    expect(
      zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, id: 'not-a-uuid' }).success
    ).toBe(false);
    expect(
      zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, id: 'x'.repeat(36) }).success
    ).toBe(false);
    expect(zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, content: '' }).success).toBe(
      false
    );
    expect(
      zCodeProMemoryUpdateRequest_unstable.safeParse({
        ...update,
        content: 'x'.repeat(2001),
      }).success
    ).toBe(false);
    expect(zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, reason: '' }).success).toBe(
      false
    );
    expect(
      zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, reason: 'x'.repeat(501) }).success
    ).toBe(false);
    expect(zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, ttlDays: 0 }).success).toBe(
      false
    );
    expect(
      zCodeProMemoryUpdateRequest_unstable.safeParse({ ...update, ttlDays: 3651 }).success
    ).toBe(false);

    const deleteRequest = {
      schemaVersion: 1,
      workingDir: 'D:\\project',
      id: update.id,
    };
    expect(zCodeProMemoryDeleteRequest_unstable.safeParse(deleteRequest).success).toBe(true);
    expect(
      zCodeProMemoryDeleteRequest_unstable.safeParse({
        ...deleteRequest,
        id: '00000000-0000-4000-8000-00000000000',
      }).success
    ).toBe(false);
    expect(
      zCodeProMemoryDeleteRequest_unstable.safeParse({
        ...deleteRequest,
        id: 'x'.repeat(36),
      }).success
    ).toBe(false);
  });
});
