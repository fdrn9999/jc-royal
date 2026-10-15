import { Button, Field, Input, Modal } from '@jc/ui';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';

/**
 * Asks for a private table's join code and trades it for a short-lived ticket (an HttpOnly cookie), so the code never
 * goes in the address. Then opens the table to sit (or, for a full table, to join its waitlist), or calls `onGranted`
 * when the table is already open.
 */
export function JoinCodeModal({
  table,
  then = 'sit',
  onClose,
  onGranted,
}: {
  table: { id: string; name: string } | null;
  then?: 'sit' | 'wait';
  onClose: () => void;
  onGranted?: () => void;
}) {
  const { t, err } = useI18n();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCode('');
    setError(null);
  }, [table?.id]);

  async function go() {
    if (!table) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/tables/${encodeURIComponent(table.id)}/access`, { body: { code: code.trim() } });
      onClose();
      if (onGranted) onGranted();
      else nav(`/table/${table.id}?${then}=1`);
    } catch (e) {
      setError(err(e instanceof ApiError ? e.code : null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!table}
      onClose={onClose}
      title={table?.name ?? ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={code.trim().length < 4} loading={busy} onClick={go} data-testid="join-code-go">
            {then === 'wait' ? t('lobby.waitJoin') : t('lobby.join')}
          </Button>
        </>
      }
    >
      <Field label={t('lobby.code')} hint={t('lobby.codeHint')}>
        {(id) => (
          <Input
            id={id}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && code.trim().length >= 4 && !busy && void go()}
            autoComplete="off"
            data-testid="join-code"
          />
        )}
      </Field>
      {error && (
        <p className="mt-2 text-sm text-[#f3b0b2]" role="alert" data-testid="join-code-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
