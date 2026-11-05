"""Read one uploaded document from stdin; no network, shell, or file writes."""
import base64, io, json, sys, warnings, zipfile
from pathlib import PurePath

MAX_TEXT=200000
def unzip_check(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries=archive.infolist()
        if len(entries)>5000 or sum(e.file_size for e in entries)>80*1024*1024 or any(e.file_size>25*1024*1024 for e in entries):
            raise ValueError('压缩文档展开后过大，请拆分文件')

def image(data):
    from PIL import Image, ImageOps
    warnings.simplefilter('error',Image.DecompressionBombWarning)
    with Image.open(io.BytesIO(data)) as source:
        if source.width*source.height>25000000: raise ValueError('图片像素过大，请缩小后重试')
        output=ImageOps.exif_transpose(source).convert('RGB');output.thumbnail((2000,2000))
        result=io.BytesIO();output.save(result,format='JPEG',quality=90)
        return {'mime':'image/jpeg','base64':base64.b64encode(result.getvalue()).decode('ascii')}

def extract(name,data):
    extension=PurePath(name).suffix.lower();texts=[];images=[]
    if extension in {'.txt','.md','.markdown','.csv','.json'}:
        try: text=data.decode('utf-8-sig')
        except UnicodeDecodeError: text=data.decode('gb18030')
        texts.append(text)
    elif extension in {'.png','.jpg','.jpeg','.webp'}: images.append(image(data))
    elif extension=='.docx':
        unzip_check(data)
        from docx import Document
        doc=Document(io.BytesIO(data));texts.extend(p.text for p in doc.paragraphs)
        for table in doc.tables:
            texts.extend('\t'.join(cell.text for cell in row.cells) for row in table.rows)
        for section in doc.sections:
            texts.extend(p.text for p in section.header.paragraphs);texts.extend(p.text for p in section.footer.paragraphs)
        for relationship in doc.part.rels.values():
            if 'image' in relationship.reltype and not relationship.is_external:
                images.append(image(relationship.target_part.blob))
                if len(images)>8: raise ValueError('文档内图片超过8张，请拆分上传')
    elif extension=='.xlsx':
        unzip_check(data)
        from openpyxl import load_workbook
        book=load_workbook(io.BytesIO(data),read_only=True,data_only=False,keep_links=False)
        try:
            if len(book.worksheets)>20: raise ValueError('表格超过20个工作表，请拆分上传')
            count=0
            for sheet in book.worksheets:
                if sheet.max_row>10000 or sheet.max_column>100 or sheet.max_row*sheet.max_column>50000:
                    raise ValueError('工作表使用区域超过50000个单元格，请清理多余格式或拆分上传')
                # Some exports declare A1 even when thousands of real cells follow.
                # Parse actual XML rows and enforce limits while consuming them.
                sheet.reset_dimensions()
                texts.append('工作表：'+sheet.title)
                for row_number,row in enumerate(sheet.iter_rows(values_only=True),1):
                    if row_number>10000 or len(row)>100:
                        raise ValueError('工作表超过10000行或100列，请拆分上传')
                    if not any(value is not None for value in row): continue
                    count+=len(row)
                    if count>50000: raise ValueError('表格超过50000个单元格，请拆分上传')
                    texts.append('\t'.join(str(value) if value is not None else '' for value in row))
        finally: book.close()
    elif extension=='.pdf':
        import pymupdf
        with pymupdf.open(stream=data,filetype='pdf') as doc:
            if doc.needs_pass: raise ValueError('PDF已加密，请先解密再上传')
            if len(doc)>50: raise ValueError('PDF超过50页，请拆分上传')
            for index,page in enumerate(doc):
                content=page.get_text();texts.append(f'第{index+1}页：\n'+content)
                if len(content.strip())<40:
                    if len(images)>=8: raise ValueError('扫描页超过8页，请拆分上传')
                    if page.rect.width*page.rect.height*2.25>25000000: raise ValueError('扫描页尺寸过大，请缩小后上传')
                    pix=page.get_pixmap(matrix=pymupdf.Matrix(1.5,1.5),alpha=False)
                    images.append(image(pix.tobytes('png')))
    else: raise ValueError('暂不支持此格式；请使用文本、CSV、JSON、XLSX、DOCX、PDF或图片')
    text='\n'.join(texts)
    if len(text)>MAX_TEXT: raise ValueError('内容超过20万字，请拆分上传；系统不会静默截断数据')
    if not text.strip() and not images: raise ValueError('文件没有可识别内容')
    return {'text':text,'images':images}

try:
    request=json.load(sys.stdin);data=base64.b64decode(request['base64'],validate=True)
    if not 0<len(data)<=10*1024*1024: raise ValueError('单个文件须在10MB以内')
    value=extract(request['name'],data)
    print(json.dumps({'ok':True,**value},ensure_ascii=True))
except Exception as error:
    message=str(error) if isinstance(error,ValueError) else '文件解析失败，请检查格式、加密状态或另存为受支持格式'
    print(json.dumps({'ok':False,'error':message},ensure_ascii=True));sys.exit(1)
