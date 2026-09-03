Calabozo de los gatos
tarea-02
Integrante-1 Lechugaluminio

Integrante-2 

Asignatura: Dispositivos Periféricos y Plataformas para la Interacción Digital DIS9087

Proyecto de reconocimiento de gestos, utilizando Python y MediaPipe. Realizado tomando como referencia este repositorio:

https://github.com/catherpiee/meowmeowcatcam
Gestos
#	Nombre	              Cómo se activa	                          imagen
1	main_room	       No detecta gesto	                             main_room
2	Point_forward	  Apunta con indice hacia la camara	            floor_colapse
3	Go_left	        Mano izquierda apunta hacia la izquierda      dead_end
4	Go_right	      Mano derecha apunta hacia la derecha          door_locked

carpeta de imágenes
https://github.com/Lechugaluminio/gatos/tree/main/dppi-tarea-02/memes

video
No lo conseguí :(

Notas: 
Alcancé la cuota en antigravity y kimi estaba saturado. Cambié a otro computador donde también alcancé la cuota de antigravity mucho más rápido que antes con otra cuenta. Volvi a mi computador y avancé con visual studio code preguntando a gemini pero en el cambio de computador dejó de funcionar la camara del programa, hasta ese momento los gestos: point_forward, praise_the_sun y main_room estaban funcionando bien. Alcancé a usar kimi un rato para agregar el gesto go_right y en visual studio agregué go_left pero no los ude probar por el problema de camara. 

```
gesture_meme.py   desktop version (OpenCV + MediaPipe Python tasks API)
app.js            browser version (MediaPipe tasks-vision WASM)
index.html        browser UI shell
memes/            meme images (+ one video, unused for now)
models/           MediaPipe .task model files used by the desktop version
requirements.txt  Python dependencies
```
