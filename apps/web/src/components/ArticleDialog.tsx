import { Modal } from './shared';
export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal id="guideDialog" title="让朗读更合心意" onClose={onClose}>
      <ol className="guide-list">
        <li>
          <b>输入文章，生成并聆听</b>
          <p>选择日文音色，调整适合自己的语速。</p>
        </li>
        <li>
          <b>直接在正文选中词汇</b>
          <p>用鼠标、触屏或 Shift + 方向键选择文字，再点击“修改读法”。</p>
        </li>
        <li>
          <b>保存读法，再次朗读</b>
          <p>同词共用一个个人读法，当前和以后文章都会采用。修改后需要重新生成。</p>
        </li>
      </ol>
    </Modal>
  );
}
