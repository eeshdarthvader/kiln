import type { Attachment } from './types';
import { AttachmentContent } from './Attachments';
import { DateLabel, Modal } from './components';

export function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  return (
    <Modal wide title={attachment.title} onClose={onClose}>
      <p className="muted attachment-meta">
        {attachment.kind.replaceAll('_', ' ')} · <DateLabel date={attachment.createdAt} />
        <br />
        <span className="path">{attachment.id}</span>
      </p>
      <section className="artifact-preview" aria-label="Attachment content">
        <AttachmentContent attachment={attachment} />
      </section>
    </Modal>
  );
}
