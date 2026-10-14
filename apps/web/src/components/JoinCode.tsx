import { Button, Field, Input, Modal } from '@jc/ui';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n';

/**
 * Asks for a private table's join code, then opens the table to sit (or, for a full table, to join its waitlist).
 * The table room checks the code.
 */
export function JoinCodeModal({ table, then = 'sit', onClose }: { table: { id: string; name: string } | null; then?: 'sit' | 'wait'; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  useEffect(() => setCode(''), [table?.id]);
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
          <Button disabled={code.trim().length < 4} onClick={() => table && nav(`/table/${table.id}?${then}=1&code=${encodeURIComponent(code.trim())}`)} data-testid="join-code-go">
            {then === 'wait' ? t('lobby.waitJoin') : t('lobby.join')}
          </Button>
        </>
      }
    >
      <Field label={t('lobby.code')} hint={t('lobby.codeHint')}>
        {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" data-testid="join-code" />}
      </Field>
    </Modal>
  );
}
