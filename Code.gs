// === 설정 ===
const GEMINI_API_KEY = 'YOUR_API_HERE';
const HF_API_TOKEN = 'YOUR_API_HERE'; // https://huggingface.co/settings/tokens 에서 발급
const SHEET_ID = 'YOUR_ID_HERE';
const SHEET_NAME = '출력결과';

// === 웹 앱 진입점 ===
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('꿈 그림 일기장')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// === 메인 함수 ===
function interpretDream(dreamText, style) {
  try {
    Logger.log('=== 꿈 해석 시작 ===');
    
    // 1단계: Gemini로 텍스트 생성
    const textResult = generateTextWithGemini(dreamText, style);
    
    // 2단계: Hugging Face로 이미지 생성
    const imageUrl = generateImageWithHuggingFace(textResult.imagePrompt);
    
    // 3단계: 시트 저장
    saveToSheet(dreamText, style, textResult.interpretation, imageUrl);
    
    return {
      success: true,
      interpretation: textResult.interpretation,
      imageUrl: imageUrl
    };
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

// === 1단계: Gemini 텍스트 생성 ===
function generateTextWithGemini(dreamText, style) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
  사용자가 꾼 꿈: "${dreamText}"
  스타일: "${style}"

  두 가지 작업을 수행해줘:
  1. 꿈 해몽 (Korean): 심리학적 관점에서 따뜻하게 해석 (3-4문장).
  2. 이미지 프롬프트 (English): "${style}" 스타일로 그리기 위한 상세한 영어 묘사. (텍스트 제외, 시각적 요소만). "이미지 프롬프트:"라고 쓰고 시작할 것.

  응답 형식 예시:
  꿈 해몽: 좋은 꿈입니다.
  이미지 프롬프트: ${style} style, a flying whale in the sky, high resolution`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());
  
  if (!result.candidates) {
    throw new Error('Gemini API 오류: ' + (result.error?.message || '응답 없음'));
  }
  
  const text = result.candidates[0].content.parts[0].text;
  
  const interpretationMatch = text.match(/꿈 해몽:([\s\S]*?)(?=이미지 프롬프트:|$)/);
  const promptMatch = text.match(/이미지 프롬프트:([\s\S]*)/);
  
  return {
    interpretation: interpretationMatch ? interpretationMatch[1].trim() : text,
    imagePrompt: promptMatch ? promptMatch[1].trim() : `${style} style artwork`
  };
}

// === 2단계: Hugging Face 이미지 생성 ===
function generateImageWithHuggingFace(prompt) {
  try {
    if (HF_API_TOKEN === 'YOUR_TOKEN_HERE') {
      throw new Error('Hugging Face 토큰이 설정되지 않았습니다.');
    }

    // 모델: FLUX.1-schnell
    const API_URL = "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell";
    
    const payload = {
      inputs: prompt,
      parameters: {
         num_inference_steps: 4 
      }
    };
    
    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${HF_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    // 모델 로딩 대기 로직 (503 에러 처리)
    let response = UrlFetchApp.fetch(API_URL, options);
    
    // 모델이 콜드 스타트 중이면 503을 뱉음 -> 대기 후 재시도
    if (response.getResponseCode() === 503) {
       Logger.log("모델 로딩 중... 10초 대기");
       Utilities.sleep(10000); 
       response = UrlFetchApp.fetch(API_URL, options); // 한 번 더 시도
    }

    if (response.getResponseCode() !== 200) {
      throw new Error(`HF API 오류: ${response.getContentText()}`);
    }
    
    // 이미지 Blob 받기
    const imageBlob = response.getBlob();
    
    // Google Drive에 저장
    const timestamp = new Date().getTime();
    imageBlob.setName(`dream_${timestamp}.png`);
    
    const file = DriveApp.createFile(imageBlob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    return `https://drive.google.com/uc?export=view&id=${file.getId()}`;
    
  } catch (error) {
    Logger.log('HF 이미지 생성 실패 (폴백 사용): ' + error.toString());
    // 실패 시 Pollinations 사용 (Fallback)
    const encoded = encodeURIComponent(prompt.substring(0,200));
    return `https://image.pollinations.ai/prompt/${encoded}?model=flux`;
  }
}

// === 시트 저장 ===
function saveToSheet(dream, style, interpretation, imageUrl) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (sheet) sheet.appendRow([new Date(), dream, style, interpretation, imageUrl]);
  } catch (e) { Logger.log('저장 실패: ' + e); }
}

// === 히스토리 가져오기 ===
function getHistory() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return { success: true, data: [] };
  
  const data = sheet.getDataRange().getValues();
  
  // 날짜 포맷팅을 위해 map 함수 보강
  const historyData = data.slice(1).reverse().map(row => {
    let dateStr = row[0];
    try {
      // 날짜 객체라면 보기 좋게 변환
      if (row[0] instanceof Date) {
        dateStr = Utilities.formatDate(row[0], Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
      }
    } catch(e) {}

    return {
      timestamp: dateStr,
      dreamText: row[1],
      style: row[2],
      interpretation: row[3],
      imageUrl: row[4]
    };
  });

  return { success: true, data: historyData };
}
