import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readCrmReplyContent,readStoredCrmReplyContent} from '../src/integrations/amocrm/reply-content.ts';

test('native picture and file payloads keep captions, names and exact declared byte count',()=>{
  const photo=readCrmReplyContent({type:'picture',text:'caption',media:'https://amojo.amocrm.ru/attachments/a.png',file_name:'Тест.png',file_size:42});
  assert.equal(photo?.media?.type,'photo');assert.equal(photo?.media?.mimeType,'image/png');assert.equal(photo?.media?.sizeBytes,42);
  assert.deepEqual(readStoredCrmReplyContent(photo),photo);
  const file=readCrmReplyContent({type:'file',media:'https://drive-b.amocrm.ru/download/a',file_name:'Тест.txt',file_size:279});
  assert.equal(file?.text,'');assert.equal(file?.media?.fileName,'Тест.txt');assert.equal(file?.media?.type,'document');
});

test('rejects untrusted URLs, oversized or unsupported media without a caption-only fallback',()=>{
  const base={type:'picture',text:'do not send as text',media:'https://amojo.amocrm.ru/attachments/a.png',file_name:'a.png',file_size:1};
  for(const extra of [{media:'http://127.0.0.1/a'}, {media:'https://evil.test/a'}, {media:'https://amojo.amocrm.ru.evil.test/a'},
    {media:'https://user:secret@amojo.amocrm.ru/a'}, {media:'https://amojo.amocrm.ru:443/a#fragment'}, {media:[]},
    {file_size:-1},{file_size:'1'},{file_size:10*1024*1024+1},{text:'x'.repeat(1025)},{type:'video'},
    {markup:{}},{forwards:{}},{template:{}}])assert.equal(readCrmReplyContent({...base,...extra}),null);
  assert.equal(readStoredCrmReplyContent({text:'bad',media:{type:'video',url:base.media,fileName:'a.mp4'}}),null);
});
