const boardElement=document.querySelector("#chess-board");
const turnLabel=document.querySelector("#turn-label");
const statusElement=document.querySelector("#chess-status");
const resetButton=document.querySelector("#reset-chess");
const symbols={K:"\u2654",Q:"\u2655",R:"\u2656",B:"\u2657",N:"\u2658",P:"\u2659",k:"\u265A",q:"\u265B",r:"\u265C",b:"\u265D",n:"\u265E",p:"\u265F"};
const names={K:"king",Q:"queen",R:"rook",B:"bishop",N:"knight",P:"pawn",k:"king",q:"queen",r:"rook",b:"bishop",n:"knight",p:"pawn"};
const initialBoard=["rnbqkbnr","pppppppp","........","........","........","........","PPPPPPPP","RNBQKBNR"].map(row=>row.split(""));
let board=initialBoard.map(row=>row.slice());
let turn="w";
let selected=null;
let selectedMoves=[];
let lastMove=null;
let gameOver=false;
let history=[];
const undoButton=document.querySelector("#undo-chess");

function colorOf(piece){if(!piece||piece===".")return null;return piece===piece.toUpperCase()?"w":"b"}
function inside(row,col){return row>=0&&row<8&&col>=0&&col<8}
function pushMove(moves,row,col,attackOnly=false){if(!inside(row,col))return false;const target=board[row][col];if(attackOnly){moves.push([row,col]);return target!=="."}if(target==="."){moves.push([row,col]);return true}if(colorOf(target)!==colorOf(board[moves.sourceRow][moves.sourceCol]))moves.push([row,col]);return false}
function pseudoMoves(row,col,attackOnly=false,position=board){const piece=position[row][col];if(piece===".")return [];const color=colorOf(piece);const type=piece.toLowerCase();const moves=[];const add=(r,c)=>{if(inside(r,c)){const target=position[r][c];if(attackOnly){moves.push([r,c]);return target!=="."}if(target==="."){moves.push([r,c]);return true}if(colorOf(target)!==color)moves.push([r,c]);}return false};
if(type==="p"){const direction=color==="w"?-1:1;const start=color==="w"?6:1;if(attackOnly){add(row+direction,col-1);add(row+direction,col+1);return moves}if(inside(row+direction,col)&&position[row+direction][col]==="."){moves.push([row+direction,col]);if(row===start&&position[row+direction*2][col]===".")moves.push([row+direction*2,col])}addPawnCapture(row+direction,col-1);addPawnCapture(row+direction,col+1);return moves}
if(type==="n"){[[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]].forEach(([dr,dc])=>add(row+dr,col+dc));return moves}
if(type==="k"){for(let dr=-1;dr<=1;dr+=1)for(let dc=-1;dc<=1;dc+=1)if(dr||dc)add(row+dr,col+dc);return moves}
const directions=type==="b"?[[1,1],[1,-1],[-1,1],[-1,-1]]:type==="r"?[[1,0],[-1,0],[0,1],[0,-1]]:[[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];directions.forEach(([dr,dc])=>{let r=row+dr,c=col+dc;while(inside(r,c)){const keepGoing=add(r,c);if(!keepGoing)break;r+=dr;c+=dc}});return moves;
function addPawnCapture(r,c){if(!inside(r,c))return;const target=position[r][c];if(target!=="."&&colorOf(target)!==color)moves.push([r,c])}
}
function findKing(side,position=board){for(let row=0;row<8;row++)for(let col=0;col<8;col++)if(position[row][col]===(side==="w"?"K":"k"))return [row,col];return null}
function inCheck(side,position=board){const king=findKing(side,position);if(!king)return true;const enemy=side==="w"?"b":"w";for(let row=0;row<8;row++)for(let col=0;col<8;col++)if(colorOf(position[row][col])===enemy&&pseudoMoves(row,col,true,position).some(([r,c])=>r===king[0]&&c===king[1]))return true;return false}
function legalMoves(row,col){const piece=board[row][col];if(colorOf(piece)!==turn)return [];return pseudoMoves(row,col).filter(([toRow,toCol])=>{const copy=board.map(line=>line.slice());copy[toRow][toCol]=copy[row][col];copy[row][col]=".";return !inCheck(turn,copy)})}
function allLegalMoves(side){let total=0;for(let row=0;row<8;row++)for(let col=0;col<8;col++)if(colorOf(board[row][col])===side)total+=legalMovesForSide(row,col,side).length;return total}
function legalMovesForSide(row,col,side){const previous=turn;turn=side;const moves=legalMoves(row,col);turn=previous;return moves}
function render(){if(!boardElement)return;boardElement.innerHTML="";for(let row=0;row<8;row++)for(let col=0;col<8;col++){const piece=board[row][col];const button=document.createElement("button");button.type="button";button.className=`chess-square ${(row+col)%2===0?"light":"dark"}`;button.dataset.row=row;button.dataset.col=col;button.setAttribute("aria-label",`${String.fromCharCode(97+col)}${8-row}${piece==="."?" empty ":` ${colorOf(piece)==="w"?"white":"black"} ${names[piece]}`}`);if(lastMove&&((lastMove.from[0]===row&&lastMove.from[1]===col)||(lastMove.to[0]===row&&lastMove.to[1]===col)))button.classList.add("last-move");if(selected&&selected[0]===row&&selected[1]===col)button.classList.add("selected");const move=selectedMoves.find(([r,c])=>r===row&&c===col);if(move){button.classList.add(piece==="."?"possible":"capture")}if(piece!=="."){const span=document.createElement("span");span.className=`chess-piece ${colorOf(piece)==="w"?"white-piece":"black-piece"}`;span.textContent=symbols[piece];button.append(span)}boardElement.append(button)}}
function updateStatus(message){if(!statusElement||!turnLabel)return;const sideName=turn==="w"?"WHITE":"BLACK";turnLabel.textContent=sideName;if(message){statusElement.textContent=message;return}const check=inCheck(turn);const moves=allLegalMoves(turn);if(moves===0){gameOver=true;statusElement.textContent=check?`${sideName} is checkmated. ${turn==="w"?"BLACK":"WHITE"} wins.`:"Stalemate. The match is drawn.";return}statusElement.textContent=check?`${sideName} is in check. Find a way through.`:"Select a piece to begin."}
function movePiece(from,to){history.push({board:board.map(r=>r.slice()),turn,lastMove,gameOver});const moving=board[from[0]][from[1]];const captured=board[to[0]][to[1]];board[to[0]][to[1]]=moving;board[from[0]][from[1]]=".";if(moving.toLowerCase()==="p"&&(to[0]===0||to[0]===7))board[to[0]][to[1]]=colorOf(moving)==="w"?"Q":"q";lastMove={from,to};selected=null;selectedMoves=[];turn=turn==="w"?"b":"w";render();updateStatus(captured!=="."?`${colorOf(moving)==="w"?"White":"Black"} captures on ${String.fromCharCode(97+to[1])}${8-to[0]}.`:"")}
function handleSquare(event){const square=event.target.closest(".chess-square");if(!square||gameOver)return;const row=Number(square.dataset.row),col=Number(square.dataset.col);const move=selectedMoves.find(([r,c])=>r===row&&c===col);if(move){movePiece(selected,move);return}if(colorOf(board[row][col])===turn){selected=[row,col];selectedMoves=legalMoves(row,col);render();updateStatus(selectedMoves.length?"Choose a highlighted destination.":"That piece has no legal moves.");return}selected=null;selectedMoves=[];render();updateStatus()}
function undo(){if(!history.length){updateStatus("Nothing to undo yet.");return}const previous=history.pop();board=previous.board.map(r=>r.slice());turn=previous.turn;lastMove=previous.lastMove;gameOver=previous.gameOver;selected=null;selectedMoves=[];render();updateStatus("Move undone. It's "+(turn==="w"?"WHITE":"BLACK")+"'s turn.")}
function reset(){board=initialBoard.map(row=>row.slice());turn="w";selected=null;selectedMoves=[];lastMove=null;gameOver=false;history=[];render();updateStatus()}
boardElement?.addEventListener("click",handleSquare);resetButton?.addEventListener("click",reset);undoButton?.addEventListener("click",undo);reset();
